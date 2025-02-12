import socketIO from 'socket.io-client';
import socketIOModern from 'socket.io-client-modern';

const eventTimeout = 2000;
const silenceTimeout = 500;

/**
 * Session is a helper class
 * for the realtime testing
 */
export default class Session {
  socket = null;
  name = '';
  listeners = new Set();
  /** @type {{string: {event: string, data: unknown}[]} */
  collected = [];

  static create(port, name = '', extraOptions = {}) {
    const options = {
      transports: ['websocket'],
      forceNew: true,
      ...extraOptions,
    };
    return new Promise((resolve, reject) => {
      const socket = socketIO.connect(`http://localhost:${port}/`, options);
      socket.on('error', reject);
      socket.on('connect_error', reject);
      socket.on('connect', () => resolve(new Session(socket, name)));
    });
  }

  static createModern(port, name = '', extraOptions = {}) {
    const options = {
      transports: ['websocket'],
      forceNew: true,
      ...extraOptions,
    };
    return new Promise((resolve, reject) => {
      const socket = socketIOModern(`http://localhost:${port}/`, options);
      socket.on('error', reject);
      socket.on('connect_error', reject);
      socket.on('connect', () => resolve(new Session(socket, name)));
    });
  }

  constructor(socket, name = '') {
    this.socket = socket;
    this.name = name;

    // To catch all events (https://stackoverflow.com/a/33960032)
    const { onevent } = socket;
    socket.onevent = function (packet) {
      const args = packet.data || [];
      onevent.call(this, packet); // original call
      packet.data = ['*'].concat(args);
      onevent.call(this, packet); // additional call to catch-all
    };
    this.listeners.add(({ event, data }) => this.collected.push({ event, data }));
    socket.on('*', (event, data) => [...this.listeners].forEach((l) => l({ event, data })));
  }

  send(event, data) {
    this.socket.emit(event, data);
  }

  sendAsync(event, data) {
    return new Promise((resolve, reject) => {
      this.socket.emit(event, data, (result) => {
        if (result.success) {
          resolve(result);
        } else {
          reject(new Error(result.message));
        }
      });
    });
  }

  disconnect() {
    this.socket.disconnect();
    this.listeners.clear();
  }

  receive(event) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `${this.name ? `${this.name}: ` : ''}Expecting '${event}' event, got timeout`,
            ),
          ),
        eventTimeout,
      );
      const handler = ({ event: receivedEvent, data }) => {
        if (receivedEvent === event) {
          this.listeners.delete(handler);
          clearTimeout(timer);
          resolve(data);
        }
      };
      this.listeners.add(handler);
    });
  }

  notReceive(event) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), silenceTimeout);
      const handler = ({ event: receivedEvent }) => {
        if (receivedEvent === event) {
          this.listeners.delete(handler);
          clearTimeout(timer);
          reject(new Error(`${this.name ? `${this.name}: ` : ''}Got unexpected '${event}' event`));
        }
      };
      this.listeners.add(handler);
    });
  }

  receiveSeq(events) {
    return new Promise((resolve, reject) => {
      const collectedData = [];
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `${this.name ? `${this.name}: ` : ''}Expecting ${JSON.stringify(
                events,
              )} events, got ${JSON.stringify(events.slice(0, collectedData.length))}`,
            ),
          ),
        eventTimeout,
      );
      const handler = ({ event: receivedEvent, data }) => {
        if (receivedEvent === events[collectedData.length]) {
          collectedData.push(data);

          if (collectedData.length === events.length) {
            this.listeners.delete(handler);
            clearTimeout(timer);
            resolve(collectedData);
          }
        }
      };
      this.listeners.add(handler);
    });
  }

  async receiveWhile(event, ...tasks) {
    const listen = this.receive(event);
    const [result] = await Promise.all([listen, ...tasks.map((t) => t())]);
    return result;
  }

  async notReceiveWhile(event, ...tasks) {
    const listen = this.notReceive(event);
    await Promise.all([listen, ...tasks.map((t) => t())]);
  }

  async receiveWhileSeq(events, ...tasks) {
    const listen = this.receiveSeq(events);
    const [result] = await Promise.all([listen, ...tasks.map((t) => t())]);
    return result;
  }

  haveCollected(event) {
    const found = this.collected.find(({ event: collectedEvent }) => collectedEvent === event);

    if (found) {
      return Promise.resolve(found.data);
    }

    return this.receive(event);
  }

  haveNotCollected(event) {
    if (this.collected.some(({ event: collectedEvent }) => collectedEvent === event)) {
      return Promise.reject(
        new Error(`${this.name ? `${this.name}: ` : ''}Got unexpected '${event}' event`),
      );
    }

    return this.notReceive(event);
  }
}
