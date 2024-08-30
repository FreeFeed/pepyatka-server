import { encode as qsEncode } from 'querystring';

import { get as _get } from 'lodash';

import { Cache } from './Cache';
import { Adapter, AuthStartParams, AuthFinishParams, Profile } from './Adapter';
import { MODE_CONNECT } from './constants';
import { AuthError } from './AuthError';

type DiscoveryResponse = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
};

type UserInfoFields = {
  id?: string;
  name?: string;
  email?: string;
  pictureURL?: string;
};

export type OAuth2Params = {
  clientId: string;
  clientSecret: string;
  scope?: string;
  userInfoFields?: UserInfoFields;
} & (
  | {
      discoveryRoot: string;
    }
  | {
      authorizationEndpoint: string;
      tokenEndpoint: string;
      userinfoEndpoint: string;
    }
);

export type Query = {
  state: string;
} & (
  | { code: string }
  | {
      error_description?: string;
      error: string;
    }
);

type StateData = {
  params: AuthStartParams;
  profile?: Profile;
};

export class OAuth2Adapter extends Adapter<Query> {
  private readonly discoveryURL?: string;
  private readonly authorizationEndpoint?: string;
  private readonly tokenEndpoint?: string;
  private readonly userinfoEndpoint?: string;
  private readonly scope: string = 'openid profile email';
  private readonly userInfoFields: UserInfoFields;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly cache = new Cache('oauth2state:', 30 * 60); // 30 minutes

  constructor(params: OAuth2Params) {
    super();

    this.clientId = params.clientId;
    this.clientSecret = params.clientSecret;

    if ('discoveryRoot' in params) {
      this.discoveryURL = `${params.discoveryRoot.replace(
        /\/$/,
        '',
      )}/.well-known/openid-configuration`;
    } else {
      this.authorizationEndpoint = params.authorizationEndpoint;
      this.tokenEndpoint = params.tokenEndpoint;
      this.userinfoEndpoint = params.userinfoEndpoint;
    }

    if (params.scope !== undefined) {
      this.scope = params.scope;
    }

    this.userInfoFields = params.userInfoFields || {};
  }

  async getAuthorizeURL(startParams: AuthStartParams): Promise<string> {
    let authUrl;

    if (this.discoveryURL) {
      const { authorization_endpoint } = await fetchJSON<DiscoveryResponse>(this.discoveryURL);
      authUrl = authorization_endpoint;
    } else {
      authUrl = this.authorizationEndpoint!;
    }

    const stateKey = await this.cache.put<StateData>({ params: startParams });
    const urlParams = {
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: startParams.redirectURL,
      state: stateKey,
      scope: this.scope,
      display: startParams.display || 'popup',
      prompt: startParams.mode === MODE_CONNECT ? 'consent' : '',
    };
    const join = authUrl.indexOf('?') !== -1 ? '&' : '?';
    return authUrl + join + qsEncode(urlParams);
  }

  async acceptResponse({ query }: AuthFinishParams<Query>): Promise<{
    params: AuthStartParams;
    profile: Profile;
  }> {
    const stateKey = query.state;
    const state = await this.cache.get<StateData>(stateKey);

    if (!state) {
      throw new AuthError('Invalid request state');
    }

    if ('error_description' in query) {
      throw new AuthError(query.error_description);
    } else if ('error' in query) {
      throw new AuthError(query.error);
    } else if (!('code' in query)) {
      throw new AuthError(`Error: no authorization code in response`);
    }

    state.profile = await this.fetchProfile(query.code, state);
    await this.cache.update(stateKey, state);
    return state as Required<StateData>;
  }

  private async fetchProfile(code: string, { params: { redirectURL } }: StateData) {
    let token_endpoint: string, userinfo_endpoint: string;

    if (this.discoveryURL) {
      ({ token_endpoint, userinfo_endpoint } = await fetchJSON<DiscoveryResponse>(
        this.discoveryURL,
      ));
    } else {
      token_endpoint = this.tokenEndpoint!;
      userinfo_endpoint = this.userinfoEndpoint!;
    }

    const access_token = await this.fetchAccessToken(code, redirectURL, token_endpoint);

    try {
      const resp = await fetchJSON<any>(userinfo_endpoint, {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: 'application/json',
        },
      });

      const userInfoFields = {
        id: 'sub',
        name: 'name',
        email: 'email',
        pictureURL: 'picture',
        ...this.userInfoFields,
      };

      const result: Partial<Profile> = {};

      for (const field of ['id', 'name', 'email', 'pictureURL']) {
        // @ts-ignore
        result[field] = _get(resp, userInfoFields[field], null);
      }

      // name and id are required
      if (!result.id) {
        throw new Error(`provider does't return the user id`);
      }

      if (!result.name) {
        result.name = 'Nameless';
      }

      return result as Profile;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AuthError(`Cannot fetch user profile: ${msg}`);
    }
  }

  private async fetchAccessToken(code: string, redirectURL: string, token_endpoint: string) {
    try {
      const body = {
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectURL,
        grant_type: 'authorization_code',
      };

      const { access_token } = await fetchJSON<{ access_token: string }>(token_endpoint, {
        method: 'POST',
        body: qsEncode(body),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
      });
      return access_token;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AuthError(`Cannot obtain access token: ${msg}`);
    }
  }
}

type GeneralErrorResponse = {
  error: string | { message: string };
};

async function fetchJSON<R extends object>(url: string, params?: RequestInit) {
  const response = await fetch(url, params);
  let respBody: R | GeneralErrorResponse = {
    error: response.ok ? 'Unknown error' : `HTTP error ${response.status}`,
  };

  try {
    respBody = (await response.json()) as R;
  } catch {
    // pass
  }

  if ('error' in respBody) {
    if (typeof respBody.error === 'string') {
      throw new Error(respBody.error);
    }

    throw new Error(respBody.error.message);
  }

  return respBody;
}
