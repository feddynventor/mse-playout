/**
 * Interface for IndexedDB entity that stores file blobs with queue position and metadata
 */
export interface QueueItem {
  /**
   * Unique identifier (auto-increment key in IndexedDB)
   */
  id?: number;

  /**
   * The file blob data
   */
  blob: Blob;

  /**
   * Numerical index representing the position in the queue
   */
  queueIndex: number;

  /**
   * Flexible metadata object that can store any additional information
   * about the queue item (e.g., filename, mimeType, duration, etc.)
   */
  metadata: Record<string, unknown>;
}

/**
 * Type alias for metadata to make it more explicit
 */
export type QueueItemMetadata = Record<string, unknown>;

