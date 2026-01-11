import { Playlist } from './playlist';
import { PlayoutBuffer } from './playout-buffer';
import { QueueItem, QueueItemMetadata } from './types/database';
import { Segment } from './types/segment';
import { RollEntry } from './types/roll';

/**
 * Options for upserting an item
 */
export interface UpsertOptions {
  /**
   * Optional ID to match an existing item for update
   * If provided and item exists, will update; otherwise will insert
   */
  id?: number;

  /**
   * Metadata fields to use for matching existing items
   * If an item with matching metadata is found, it will be updated
   * Common fields: 'filename', 'originalIndex', etc.
   */
  matchBy?: {
    /**
     * Field names in metadata to match against
     * All specified fields must match for an update to occur
     */
    fields: string[];
    /**
     * Values to match for each field (in same order as fields)
     */
    values: unknown[];
  };

  /**
   * Optional queue index position
   * If not provided, item will be appended to the end
   */
  queueIndex?: number;

  /**
   * Whether to update the blob if item already exists
   * Default: true
   */
  updateBlob?: boolean;

  /**
   * Whether to merge metadata or replace it entirely
   * Default: true (merge)
   */
  mergeMetadata?: boolean;
}

/**
 * Result of an upsert operation
 */
export interface UpsertResult {
  /**
   * The ID of the item (existing or newly created)
   */
  id: number;

  /**
   * Whether this was an insert (true) or update (false)
   */
  inserted: boolean;

  /**
   * The matched item ID if an update occurred, undefined if insert
   */
  matchedId?: number;
}

/**
 * Roll class that manages playlist ordering based on external data source
 * This is the ONLY interface to the Playlist database - all operations go through Roll
 * Updates the queueIndex of items in the playlist based on matching by id
 */
export class Roll {
  private playlist: Playlist;
  private entries: RollEntry[];
  private playoutBuffer: PlayoutBuffer | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private bufferThresholdSeconds = 4;
  private bufferedQueueIndex = 0;
  private totalItems = 0;
  private pendingTrimBoundary: number | null = null;
  private nextSegmentScheduled = false;
  private onRollEndCallback: (() => void) | null = null;
  private onStreamEndCallback: (() => void) | null = null;
  private readonly boundTimeUpdate = this.handleTimeUpdate.bind(this);
  private readonly boundEnded = this.handleEnded.bind(this);

  /**
   * Creates a new Roll instance
   * @param playlist - The Playlist instance to manage (will be initialized internally)
   * @param entries - Unified array of file paths with ordering information
   */
  constructor(playlist: Playlist, entries: RollEntry[]) {
    this.playlist = playlist;
    this.entries = entries;
  }

  /**
   * Initializes the playlist database
   */
  async init(): Promise<void> {
    await this.playlist.init();
  }

  /**
   * Adds a media file to the playlist
   * @param blob - The file blob to store
   * @param metadata - Optional metadata for the item
   * @returns The ID of the added item
   * @deprecated Use upsertItem for better control over insert/update behavior
   */
  async addItem(blob: Blob, metadata: QueueItemMetadata = {}): Promise<number> {
    return await this.playlist.add(blob, metadata);
  }

  /**
   * Upserts (insert or update) a media file in the playlist
   * Matches existing items by ID or metadata fields, then updates or inserts accordingly
   * 
   * @param blob - The file blob to store or update
   * @param metadata - Metadata for the item
   * @param options - Options for matching and updating behavior
   * @returns Result containing the item ID and whether it was inserted or updated
   * 
   * @example
   * // Upsert by ID
   * const result = await roll.upsertItem(blob, { filename: 'video.mp4' }, { id: 123 });
   * 
   * @example
   * // Upsert by metadata matching
   * const result = await roll.upsertItem(blob, { filename: 'video.mp4', originalIndex: 0 }, {
   *   matchBy: { fields: ['filename'], values: ['video.mp4'] }
   * });
   * 
   * @example
   * // Insert at specific position
   * const result = await roll.upsertItem(blob, metadata, { queueIndex: 5 });
   */
  async upsertItem(
    blob: Blob,
    metadata: QueueItemMetadata = {},
    options: UpsertOptions = {}
  ): Promise<UpsertResult> {
    let existingItem: QueueItem | null = null;
    let matchedId: number | undefined;

    // Try to find existing item by ID first
    if (options.id !== undefined) {
      existingItem = await this.playlist.getItem(options.id);
      if (existingItem) {
        matchedId = options.id;
      }
    }

    // If not found by ID, try matching by metadata
    if (!existingItem && options.matchBy) {
      const matched = await this.findItemByMetadata(
        options.matchBy.fields,
        options.matchBy.values
      );
      if (matched) {
        existingItem = matched;
        matchedId = matched.id;
      }
    }

    if (existingItem && matchedId !== undefined) {
      // Update existing item
      const updateBlob = options.updateBlob !== false; // default true
      const mergeMetadata = options.mergeMetadata !== false; // default true

      const updateData: Partial<QueueItem> = {
        ...(updateBlob && { blob }),
        ...(options.queueIndex !== undefined && { queueIndex: options.queueIndex }),
        metadata: mergeMetadata
          ? { ...existingItem.metadata, ...metadata }
          : metadata,
      };

      await this.playlist.updateItem(matchedId, updateData);

      return {
        id: matchedId,
        inserted: false,
        matchedId,
      };
    } else {
      // Insert new item
      const id = await this.playlist.add(blob, metadata, options.queueIndex);
      return {
        id,
        inserted: true,
      };
    }
  }

  /**
   * Batch upserts multiple items
   * More efficient than calling upsertItem multiple times
   * 
   * @param items - Array of items to upsert
   * @param defaultOptions - Default options applied to all items (can be overridden per item)
   * @returns Array of results in the same order as input items
   * 
   * @example
   * const results = await roll.upsertItems([
   *   { blob: blob1, metadata: { filename: 'video1.mp4' }, options: { matchBy: { fields: ['filename'], values: ['video1.mp4'] } } },
   *   { blob: blob2, metadata: { filename: 'video2.mp4' }, options: { matchBy: { fields: ['filename'], values: ['video2.mp4'] } } },
   * ]);
   */
  async upsertItems(
    items: Array<{
      blob: Blob;
      metadata?: QueueItemMetadata;
      options?: UpsertOptions;
    }>,
    defaultOptions: UpsertOptions = {}
  ): Promise<UpsertResult[]> {
    const results: UpsertResult[] = [];
    
    for (const item of items) {
      const mergedOptions: UpsertOptions = {
        ...defaultOptions,
        ...item.options,
        // Merge matchBy if both exist
        matchBy: item.options?.matchBy || defaultOptions.matchBy,
      };
      
      const result = await this.upsertItem(
        item.blob,
        item.metadata || {},
        mergedOptions
      );
      results.push(result);
    }
    
    return results;
  }

  /**
   * Convenience method to upsert an item by filename
   * This is a common use case where items are identified by their filename
   * 
   * @param blob - The file blob to store or update
   * @param filename - The filename to match against
   * @param metadata - Additional metadata (filename will be added automatically)
   * @param options - Additional upsert options
   * @returns Result containing the item ID and whether it was inserted or updated
   * 
   * @example
   * const result = await roll.upsertItemByFilename(blob, 'video.mp4', { duration: 120 });
   */
  async upsertItemByFilename(
    blob: Blob,
    filename: string,
    metadata: QueueItemMetadata = {},
    options: Omit<UpsertOptions, 'matchBy'> = {}
  ): Promise<UpsertResult> {
    return this.upsertItem(
      blob,
      { ...metadata, filename },
      {
        ...options,
        matchBy: {
          fields: ['filename'],
          values: [filename],
        },
      }
    );
  }

  /**
   * Finds an item by matching metadata fields
   * @param fields - Field names to match
   * @param values - Values to match (in same order as fields)
   * @returns The matching item or null
   */
  private async findItemByMetadata(
    fields: string[],
    values: unknown[]
  ): Promise<QueueItem | null> {
    if (fields.length !== values.length) {
      throw new Error('Fields and values arrays must have the same length');
    }

    const allItems = await this.playlist.getAll();
    
    for (const item of allItems) {
      let matches = true;
      for (let i = 0; i < fields.length; i++) {
        const fieldValue = item.metadata[fields[i]];
        if (fieldValue !== values[i]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return item;
      }
    }
    
    return null;
  }

  /**
   * Gets all items from the playlist, sorted by queueIndex
   */
  async getAllItems(): Promise<QueueItem[]> {
    return await this.playlist.getAll();
  }

  /**
   * Gets an item by its ID
   */
  async getItem(id: number): Promise<QueueItem | null> {
    return await this.playlist.getItem(id);
  }

  /**
   * Gets the number of items in the playlist
   */
  async length(): Promise<number> {
    return await this.playlist.length();
  }

  /**
   * Checks if the playlist is empty
   */
  async isEmpty(): Promise<boolean> {
    return await this.playlist.isEmpty();
  }

  /**
   * Clears all items from the playlist
   */
  async clear(): Promise<void> {
    return await this.playlist.clear();
  }

  /**
   * Gets the unified entries (file paths with ordering)
   */
  getEntries(): RollEntry[] {
    return this.entries;
  }

  /**
   * Sets a callback to be called when the roll completes (all items have been queued once)
   * If no callback is set, the roll will loop indefinitely (default behavior)
   * @param callback - Function to call when roll ends, or null to remove callback and enable looping
   */
  setOnRollEnd(callback: (() => void) | null): void {
    this.onRollEndCallback = callback;
  }

  /**
   * Sets a callback to be called when the stream ends (playback reaches the end)
   * @param callback - Function to call when stream ends, or null to remove callback
   */
  setOnStreamEnd(callback: (() => void) | null): void {
    this.onStreamEndCallback = callback;
  }

  /**
   * Resets the queue index to allow the roll to start from the beginning
   * This is useful when a roll end callback wants to restart the cycle
   * without detaching and reattaching the buffer
   */
  resetQueueIndex(): void {
    this.bufferedQueueIndex = 0;
    this.pendingTrimBoundary = null;
    this.nextSegmentScheduled = false;
  }

  /**
   * Attaches a playout buffer and video element so Roll can auto-queue items
   */
  async attachBuffer(
    playoutBuffer: PlayoutBuffer,
    videoElement: HTMLVideoElement,
    options: { thresholdSeconds?: number } = {}
  ): Promise<void> {
    this.detachBuffer();
    this.playoutBuffer = playoutBuffer;
    this.videoElement = videoElement;
    if (options.thresholdSeconds !== undefined) {
      this.bufferThresholdSeconds = options.thresholdSeconds;
    }

    this.totalItems = await this.playlist.length();
    this.bufferedQueueIndex = 0;
    this.pendingTrimBoundary = null;
    this.nextSegmentScheduled = false;
    this.videoElement.addEventListener('timeupdate', this.boundTimeUpdate);
    this.videoElement.addEventListener('ended', this.boundEnded);

    if (this.totalItems === 0) {
      console.warn('Roll: playlist is empty, nothing to buffer');
      return;
    }

    await this.queueNextSegment();
  }

  /**
   * Detaches buffer listeners and resets internal buffering state
   */
  detachBuffer(): void {
    if (this.videoElement) {
      this.videoElement.removeEventListener('timeupdate', this.boundTimeUpdate);
      this.videoElement.removeEventListener('ended', this.boundEnded);
    }

    this.playoutBuffer = null;
    this.videoElement = null;
    this.bufferedQueueIndex = 0;
    this.totalItems = 0;
    this.pendingTrimBoundary = null;
    this.nextSegmentScheduled = false;
  }

  private handleTimeUpdate(): void {
    void this.onTimeUpdate();
  }

  private handleEnded(): void {
    if (this.onStreamEndCallback) {
      this.onStreamEndCallback();
    }
  }

  private async onTimeUpdate(): Promise<void> {
    if (!this.videoElement || !this.playoutBuffer) {
      return;
    }

    const currentTime = this.videoElement.currentTime;

    if (this.pendingTrimBoundary !== null && currentTime >= this.pendingTrimBoundary) {
      this.playoutBuffer.trim(0, this.pendingTrimBoundary);
      this.pendingTrimBoundary = null;
      this.nextSegmentScheduled = false;
    }

    const hasMore = await this.hasMoreSegments();
    
    // Check for stream end when no more segments and playback is at end
    if (this.onStreamEndCallback && !hasMore) {
      const bufferedEnd = this.getBufferedEnd();
      if (bufferedEnd > 0 && currentTime >= Math.max(0, bufferedEnd - 0.1)) {
        this.onStreamEndCallback();
      }
    }

    if (!hasMore) {
      return;
    }

    if (!this.nextSegmentScheduled && this.shouldQueueNextVideo(currentTime)) {
      void this.queueNextSegment();
    }
  }

  private shouldQueueNextVideo(currentTime: number): boolean {
    if (!this.videoElement) {
      return false;
    }

    // For source buffers, videoElement.duration can be Infinity
    // Use the buffered end time instead, which represents the actual duration of buffered content
    const bufferedEnd = this.getBufferedEnd();
    if (bufferedEnd === 0) {
      return false;
    }

    return bufferedEnd - currentTime <= this.bufferThresholdSeconds;
  }

  private async queueNextSegment(): Promise<void> {
    if (!this.playoutBuffer || !this.videoElement) {
      return;
    }

    if (this.nextSegmentScheduled) {
      return;
    }

    this.nextSegmentScheduled = true;
    try {
      const items = await this.playlist.getAll();
      this.totalItems = items.length;
      if (items.length === 0) {
        this.nextSegmentScheduled = false;
        return;
      }

      // Loop back to the first item when we reach the end (if no callback is set)
      const currentIndex = this.bufferedQueueIndex % items.length;
      const item = items[currentIndex];
      if (!item.blob) {
        console.warn('Roll: queue item has no blob data', item.id);
        this.nextSegmentScheduled = false;
        return;
      }

      const previousBoundary = this.getBufferedEnd();
      const segment = await this.createSegmentFromItem(item);
      this.playoutBuffer.enqueue(segment);
      this.bufferedQueueIndex += 1;

      // Check if we've just completed a full cycle after incrementing
      // When bufferedQueueIndex becomes a multiple of items.length, we've queued all items once
      if (this.onRollEndCallback && this.bufferedQueueIndex > 0 && this.bufferedQueueIndex % items.length === 0) {
        // We've completed a full cycle, call the callback
        this.onRollEndCallback();
      }

      if (previousBoundary > 0 && this.pendingTrimBoundary === null) {
        this.pendingTrimBoundary = previousBoundary;
        // nextSegmentScheduled stays true until trim happens
      } else {
        // No trim boundary to wait for, clear the flag so next segment can be queued immediately
        this.nextSegmentScheduled = false;
      }
    } catch (error) {
      console.error('Roll: Failed to queue next segment', error);
      this.nextSegmentScheduled = false;
    }
  }

  private async hasMoreSegments(): Promise<boolean> {
    const length = await this.playlist.length();
    this.totalItems = length;
    // return this.bufferedQueueIndex < length;
    
    if (length === 0) {
      return false;
    }

    // If callback is set, stop after completing one full cycle
    if (this.onRollEndCallback) {
      return this.bufferedQueueIndex < length;
    }

    // If no callback, loop indefinitely (always return true if there are items)
    return true;
  }

  private async createSegmentFromItem(item: QueueItem): Promise<Segment> {
    const data = await this.blobToArrayBuffer(item.blob);
    const segmentId =
      (item.metadata.originalIndex as number | undefined) ??
      item.queueIndex ??
      item.id ??
      0;
    const streamId =
      (item.metadata.streamId as string | undefined) ??
      (item.metadata.stream_id as string | undefined) ??
      'main-stream';

    return {
      id: segmentId,
      data,
      variant: {
        stream_id: streamId,
      },
    };
  }

  private blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(reader.result);
        } else {
          reject(new Error('Failed to convert blob to ArrayBuffer'));
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
  }

  private getBufferedEnd(): number {
    if (!this.videoElement) {
      return 0;
    }

    const buffered = this.videoElement.buffered;
    if (buffered.length === 0) {
      return 0;
    }

    return buffered.end(buffered.length - 1);
  }

  /**
   * Updates the ordering index of items in the playlist based on the `entries` metadata
   * Matches items by metadata that references the original entry file or index.
   * @returns Number of items updated
   */
  async updateOrdering(): Promise<number> {
    try {
      const playlistItems = await this.playlist.getAll();
      
      if (playlistItems.length === 0) {
        console.warn('Roll: Playlist is empty, nothing to update');
        return 0;
      }

      const orderingData = this.buildOrderingFromEntries(playlistItems);
      if (orderingData.length === 0) {
        console.warn('Roll: No matching entries found for playlist items');
        return 0;
      }

      return await this.reorderAllItems(orderingData, playlistItems);
    } catch (error) {
      console.error('Roll: Failed to update ordering:', error);
      throw error;
    }
  }

  private buildOrderingFromEntries(playlistItems: QueueItem[]): Array<{ id: number; order: number }> {
    const entryByFilename = new Map<string, RollEntry>();
    for (const entry of this.entries) {
      entryByFilename.set(entry.file, entry);
    }

    const entryByOriginalIndex = new Map<number, RollEntry>();
    this.entries.forEach((entry, index) => {
      entryByOriginalIndex.set(index, entry);
    });

    const ordering: Array<{ id: number; order: number }> = [];
    for (const item of playlistItems) {
      if (item.id === undefined) {
        continue;
      }

      const filename = item.metadata.filename as string | undefined;
      const originalIndex = item.metadata.originalIndex as number | undefined;
      const entry = (filename && entryByFilename.get(filename)) ?? (originalIndex !== undefined && entryByOriginalIndex.get(originalIndex));
      if (entry && Number.isFinite(entry.order)) {
        ordering.push({ id: item.id, order: entry.order });
      }
    }

    return ordering;
  }

  private async reorderAllItems(
    orderingData: Array<{ id: number; order: number }>,
    playlistItems: QueueItem[]
  ): Promise<number> {
    if (playlistItems.length === 0) {
      return 0;
    }

    const orderMap = new Map<number, number>();
    for (const datum of orderingData) {
      orderMap.set(datum.id, datum.order);
    }

    const itemsWithOrder: Array<{ item: QueueItem; order: number }> = [];
    const itemsWithoutOrder: QueueItem[] = [];

    for (const item of playlistItems) {
      if (item.id === undefined) {
        continue;
      }

      const desiredOrder = orderMap.get(item.id);
      if (desiredOrder !== undefined) {
        itemsWithOrder.push({ item, order: desiredOrder });
      } else {
        itemsWithoutOrder.push(item);
      }
    }

    itemsWithOrder.sort((a, b) => a.order - b.order);

    const finalOrdering: Array<{ id: number; queueIndex: number }> = [];
    for (let i = 0; i < itemsWithOrder.length; i++) {
      finalOrdering.push({
        id: itemsWithOrder[i].item.id!,
        queueIndex: i,
      });
    }

    const startIndex = itemsWithOrder.length;
    for (let i = 0; i < itemsWithoutOrder.length; i++) {
      if (itemsWithoutOrder[i].id === undefined) {
        continue;
      }

      finalOrdering.push({
        id: itemsWithoutOrder[i].id!,
        queueIndex: startIndex + i,
      });
    }

    await this.playlist.batchUpdateQueueIndices(finalOrdering);
    return itemsWithOrder.length;
  }

  /**
   * Gets the current ordering state
   * @returns Array of items with their current id and queueIndex
   */
  async getCurrentOrdering(): Promise<Array<{ id: number; queueIndex: number }>> {
    const items = await this.playlist.getAll();
    return items
      .filter(item => item.id !== undefined)
      .map(item => ({
        id: item.id!,
        queueIndex: item.queueIndex,
      }))
      .sort((a, b) => a.queueIndex - b.queueIndex);
  }

  /**
   * Compares current ordering with the entries-based ordering
   * @returns Object with match status and details
   */
  async compareOrdering(): Promise<{
    matches: boolean;
    current: Array<{ id: number; queueIndex: number }>;
    desired: Array<{ id: number; order: number }>;
    differences: Array<{ id: number; currentOrder: number; desiredOrder: number }>;
  }> {
    const current = await this.getCurrentOrdering();
    const playlistItems = await this.playlist.getAll();
    const desired = this.buildOrderingFromEntries(playlistItems);

    const currentMap = new Map(current.map(item => [item.id, item.queueIndex]));
    const desiredMap = new Map(desired.map(item => [item.id, item.order]));

    const differences: Array<{ id: number; currentOrder: number; desiredOrder: number }> = [];

    for (const [id, desiredOrder] of desiredMap.entries()) {
      const currentOrder = currentMap.get(id);
      if (currentOrder !== undefined && currentOrder !== desiredOrder) {
        differences.push({ id, currentOrder, desiredOrder });
      }
    }

    return {
      matches: differences.length === 0,
      current,
      desired,
      differences,
    };
  }

  /**
   * Closes the database connection
   */
  close(): void {
    this.detachBuffer();
    this.playlist.close();
  }
}

