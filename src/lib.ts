/**
 * MSE Playout Library
 * 
 * A library for managing media playout using MediaSource Extensions (MSE)
 * with IndexedDB-backed playlist management.
 */

// Core classes
export { PlayoutBuffer } from './playout-buffer';
export { Playlist } from './playlist';
export { Roll } from './roll';

// Types
export type { Segment } from './types/segment';
export type { RollEntry, RollItem, RollDataSource } from './types/roll';
export type { QueueItem, QueueItemMetadata } from './types/database';

// Roll-specific types
export type { UpsertOptions, UpsertResult } from './roll';

