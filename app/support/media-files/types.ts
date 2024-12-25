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

export type MediaInfoVideo = {
  type: 'video';
  format: string;
  vCodec: string;
  aCodec?: string;
  isAnimatedImage?: true;
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

export type Stream = { codec_name: string } & (
  | {
      codec_type: 'video';
      width: number;
      height: number;
      nb_frames: string;
      side_data_list?: Record<string, string>[];
    }
  | {
      codec_type: 'audio';
    }
);

export type FfprobeResult = {
  format: { format_name: string; duration: string; tags?: Record<string, string> };
  streams: Stream[];
};
