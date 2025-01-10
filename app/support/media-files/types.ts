export type MediaType = 'image' | 'video' | 'audio' | 'general';

export type MediaInfoVisual = {
  width: number;
  height: number;
};

export type MediaInfoPlayable = {
  duration: number;
};

export type MediaInfoCommon = {
  extension: string;
  tags?: Record<string, string>;
};

export type MediaInfoImage = {
  type: 'image';
  format: string;
} & MediaInfoVisual &
  MediaInfoCommon;

export type H264Info = {
  profile: string;
  level: number;
  pix_fmt: string;
};

export type MediaInfoVideo = {
  type: 'video';
  format: string;
  vCodec: string;
  aCodec?: string;
  isAnimatedImage?: true;
  h264info?: H264Info;
} & MediaInfoVisual &
  MediaInfoPlayable &
  MediaInfoCommon;

export type MediaInfoAudio = {
  type: 'audio';
  format: string;
  aCodec: string;
} & MediaInfoPlayable &
  MediaInfoCommon;

export type MediaInfoGeneral = {
  type: 'general';
} & MediaInfoCommon;

export type MediaInfo = MediaInfoImage | MediaInfoVideo | MediaInfoAudio | MediaInfoGeneral;

/**
 * Data structure (almost) ready to be stored in DB
 */
export type MediaProcessResult = {
  mediaType: MediaType;
  fileName: string;
  fileSize: number;
  fileExtension: string;
  mimeType: string;

  width?: number;
  height?: number;
  duration?: number;
  previews?: {
    image?: VisualPreviews;
    video?: VisualPreviews;
    audio?: NonVisualPreviews;
  };
  meta?: {
    animatedImage?: true;
    'dc:title'?: string;
    'dc:creator'?: string;
  };

  files?: FilesToUpload;
};

export type FilesToUpload = { [variant: string]: { path: string; ext: string } };

export type VisualPreviews = { [variant: string]: { w: number; h: number; ext: string } };
export type NonVisualPreviews = { [variant: string]: { ext: string } };

export type Stream = { codec_name: string } & (
  | {
      codec_type: 'video';
      width: number;
      height: number;
      nb_frames: string;
      side_data_list?: Record<string, string>[];
      is_avc?: 'true' | 'false';
    }
  | {
      codec_type: 'audio';
    }
);

export type AvcStream = Stream & {
  is_avc: 'true';
  profile: string;
  level: number;
  pix_fmt: string;
};

export type FfprobeResult = {
  format: { format_name: string; duration: string; tags?: Record<string, string> };
  streams: Stream[];
};

export type Box = {
  width: number;
  height: number;
};

export type ImageGeneratedPreview = {
  variant: string;
  width: number;
  height: number;
  extension: string;
  path: string;
};
