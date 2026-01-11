/**
 * Represents a video segment that can be appended to the SourceBuffer
 */
export interface Segment {
  id: number;
  data?: ArrayBuffer;
  variant?: {
    stream_id: string;
    init?: ArrayBuffer;
  };
}

