# MSE Playout Library

A TypeScript library for managing media playout using MediaSource Extensions (MSE) with IndexedDB-backed playlist management.

## Features

- **PlayoutBuffer**: Manages MediaSource API for seamless video playback
- **Playlist**: IndexedDB-based queue management for media items
- **Roll**: High-level interface for managing playlist ordering and playout

## Installation

### From npm (when published)

```bash
npm install mse-playout
```

### Local Development

In the library directory (`mse-playout`):
```bash
npm run build
npm link
```

```bash
npm link mse-playout
```

This creates a symlink, so changes to the library are immediately available. Rebuild the library after making changes:
```bash
npm run build
```

## Usage

### Basic Example

```typescript
import { PlayoutBuffer, Playlist, Roll } from 'mse-playout';
import type { RollEntry } from 'mse-playout';

// Define your media entries
const rollEntries: RollEntry[] = [
  { file: 'assets/video1.mp4', order: 0, metadata: { title: 'Video 1' } },
  { file: 'assets/video2.mp4', order: 1, metadata: { title: 'Video 2', subtitle: "Lorem Ipsum" } },
];

// Initialize playlist and roll
const playlist = new Playlist('my-playlist-db', 'queue-items', 1);
const roll = new Roll(playlist, rollEntries);
await roll.init();

// Get video element
const videoElement = document.getElementById('video') as HTMLVideoElement;

// Create playout buffer and attach to roll
const playoutBuffer = new PlayoutBuffer(videoElement);
await roll.attachBuffer(playoutBuffer, videoElement);

// Play the video
await videoElement.play();
```

### Using Playlist Data structure

```typescript
import { Playlist } from 'mse-playout';

const playlist = new Playlist('my-db', 'items', 1);
await playlist.init();

// Add items
const blob = new Blob([/* video data */], { type: 'video/mp4' });
const id = await playlist.add(blob, { filename: 'video.mp4' });

// Get all items
const items = await playlist.getAll();

// Navigate
const current = await playlist.current();
const next = await playlist.next();
```

### Using Roll for Advanced Management

```typescript
import { Roll } from 'mse-playout';

const roll = new Roll(playlist, rollEntries);
await roll.init();

// Upsert items (insert or update)
const result = await roll.upsertItemByFilename(
  blob,
  'video.mp4',
  { title: 'My Video' },
  { queueIndex: 0 }
);

// Update ordering from external data source
const updatedCount = await roll.updateOrdering();

// Get all items
const items = await roll.getAllItems();
```

## Development

### Setup

Install dependencies:
```bash
npm install
```

### Development Server (Demo)

Run the demo application:
```bash
npm run dev
```

The demo will be available at `http://localhost:3000`

### Build

Build the library:
```bash
npm run build
```

This will create:
- `dist/index.js` - UMD bundle
- `dist/index.d.ts` - TypeScript declarations

Build the demo:
```bash
npm run build:demo
```

### Type Checking

Run TypeScript type checking:
```bash
npm run type-check
```

## API Reference

### Classes

- **PlayoutBuffer**: Manages MediaSource and SourceBuffer for video playback
- **Playlist**: IndexedDB-based queue management
- **Roll**: High-level playlist and playout management

### Types

- `Segment`: Video segment interface
- `RollEntry`: Entry definition for roll
- `RollItem`: Item in roll data source
- `QueueItem`: Item stored in IndexedDB
- `UpsertOptions`: Options for upsert operations
- `UpsertResult`: Result of upsert operation

See the TypeScript declarations in `dist/index.d.ts` for full API documentation.

## License

ISC
