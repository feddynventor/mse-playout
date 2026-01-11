import { Segment } from './types/segment';

interface PlayoutBufferState {
  queueLength: number;
  lastSegmentId: number | null;
}

interface QueuedSegment extends Segment {
  data: ArrayBuffer;
  isInit?: boolean;
}

interface PlayoutBufferOptions {
  mimeType?: string;
}

export class PlayoutBuffer {
  private readonly mediaSource: MediaSource;
  private source: SourceBuffer | null = null;
  private readonly queue: QueuedSegment[] = [];
  private lastSegmentId: number | null = null;
  private pendingTrimRanges: Array<{ start: number; end: number }> = [];
  private objectUrl: string | null = null;
  private readonly mimeType: string;
  private readonly boundSourceOpen = this.handleSourceOpen.bind(this);
  private readonly boundFlush = this.flush.bind(this);

  constructor(
    private readonly videoElement: HTMLVideoElement,
    options: PlayoutBufferOptions = {}
  ) {
    this.mimeType = options.mimeType ?? 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.videoElement.src = this.objectUrl;
    this.videoElement.load();
    this.mediaSource.addEventListener('sourceopen', this.boundSourceOpen);
  }

  enqueue(segment: Segment) {
    if (segment.variant?.init) {
      this.queue.push({
        id: segment.id,
        data: segment.variant.init,
        variant: segment.variant,
        isInit: true,
      });
    }

    if (!segment.data) {
      console.warn('Skipping segment without data', segment.id);
      return;
    }

    this.queue.push({
      id: segment.id,
      data: segment.data,
      variant: segment.variant,
      isInit: false,
    });

    this.flush();
  }

  getBufferState(): PlayoutBufferState {
    return {
      queueLength: this.queue.length,
      lastSegmentId: this.lastSegmentId,
    };
  }

  close() {
    this.mediaSource.removeEventListener('sourceopen', this.boundSourceOpen);
    if (this.source) {
      this.source.removeEventListener('updateend', this.boundFlush);
    }
    if (this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch (error) {
        console.warn('MediaSource endOfStream failed', error);
      }
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.queue.length = 0;
    this.source = null;
    this.lastSegmentId = null;
    this.videoElement.src = '';
    this.videoElement.load();
  }

  private handleSourceOpen() {
    if (this.source) {
      return;
    }

    if (!MediaSource.isTypeSupported(this.mimeType)) {
      console.warn(`MIME type ${this.mimeType} is not supported by this browser`);
    }

    try {
      this.source = this.mediaSource.addSourceBuffer(this.mimeType);
      this.source.mode = 'sequence';
      this.source.addEventListener('updateend', this.boundFlush);
      this.flush();
    } catch (error) {
      console.error('Failed to create SourceBuffer', error);
    }
  }

  trim(start: number, end: number) {
    if (Number.isNaN(start) || Number.isNaN(end)) {
      return;
    }

    const safeStart = Math.max(0, start);
    const safeEnd = Math.max(safeStart, end);
    if (safeEnd <= safeStart) {
      return;
    }

    this.pendingTrimRanges.push({ start: safeStart, end: safeEnd });
    this.flush();
  }

  private flush() {
    // console.log('Processing ahead', this.queue);
    if (!this.source) {
      return;
    }

    if (this.source.updating) {
      return;
    }

    if (this.pendingTrimRanges.length > 0) {
      const range = this.pendingTrimRanges.shift()!;
      try {
        this.source.remove(range.start, range.end);
        return;
      } catch (error) {
        console.error('SourceBuffer trim failed', error);
      }
    }

    if (this.queue.length === 0) {
      return;
    }

    const snapshot = [...this.queue];
    for (const segment of snapshot) {
      if (!this.source || this.source.updating) {
        break;
      }

      const queued = this.queue.shift();
      if (!queued) {
        continue;
      }

      try {
        this.source.appendBuffer(queued.data);
        if (!queued.isInit) {
          this.lastSegmentId = queued.id;
        }
        // console.log('Pushed to buffer', queued.data.byteLength);
      } catch (error) {
        console.error('appendBuffer failed for segment', queued.id, error);
        this.queue.unshift(queued);
        break;
      }
    }
  }
}
