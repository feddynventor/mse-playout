/**
 * Unified entity that combines file path with ordering information
 * This is the single source of truth for what should be in the playlist
 */
export interface RollEntry {
  /**
   * File path or URL to the media file
   */
  file: string;

  /**
   * Desired position in the queue (queueIndex)
   */
  order: number;

  /**
   * Optional metadata to store with the item
   */
  metadata?: Record<string, unknown>;
}

/**
 * Interface for items in the data source that define ordering
 * The id field is mandatory and must match the QueueItem.id
 */
export interface RollItem {
  /**
   * Mandatory identifier that matches the QueueItem.id in the playlist
   */
  id: number;

  /**
   * Desired position in the queue (queueIndex)
   */
  order: number;
}

/**
 * Type for the data source function/array that provides roll ordering
 */
export type RollDataSource = RollItem[] | (() => Promise<RollItem[]>) | (() => RollItem[]);

