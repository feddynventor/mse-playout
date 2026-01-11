import { PlayoutBuffer, Playlist, Roll } from '../src/index';
import type { Segment, RollEntry } from '../src/index';

// Unified entity: file paths with ordering information
// This is the single source of truth for what should be in the playlist
const rollEntries: RollEntry[] = [
  { file: './bump.mp4', order: 0, metadata: { title: 'Bump' } },
  { file: './test1.mp4', order: 1, metadata: { title: 'Test 1' } },
  { file: './test2.mp4', order: 2, metadata: { title: 'Test 2' } },
];

let playoutBuffer: PlayoutBuffer | null = null;
let roll: Roll | null = null;

const videoElement = document.getElementById('videoElement') as HTMLVideoElement;
const loadBtn = document.getElementById('loadBtn') as HTMLButtonElement;
const playBtn = document.getElementById('playBtn') as HTMLButtonElement;
const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;

if (!videoElement || !loadBtn || !playBtn || !pauseBtn || !resetBtn || !statusDiv) {
  throw new Error('Missing UI elements');
}

const updateStatus = (message: string, type: 'info' | 'loading' | 'success' | 'error' = 'info') => {
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
};

/**
 * Converts a Blob to ArrayBuffer
 */
const blobToArrayBuffer = (blob: Blob): Promise<ArrayBuffer> => {
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
};

const createSegment = (id: number, data: ArrayBuffer): Segment => ({
  id,
  data,
  variant: {
    stream_id: 'main-stream',
  },
});

const fetchSegment = async (file: string, id: number): Promise<Segment> => {
  const response = await fetch(file);
  if (!response.ok) {
    throw new Error(`Failed to download ${file}: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    throw new Error(`Empty segment: ${file}`);
  }
  return createSegment(id, arrayBuffer);
};

const cleanup = () => {
  playBtn.disabled = true;
  pauseBtn.disabled = true;
  resetBtn.disabled = true;

  if (playoutBuffer) {
    playoutBuffer.close();
    playoutBuffer = null;
  }

  videoElement.pause();
  videoElement.src = '';
  videoElement.load();
};

/**
 * Loads and concatenates videos, demonstrating upsert functionality:
 * - Example 1: Upsert items by filename (inserts new or updates existing)
 * - Example 2: Batch upsert operations
 * - Example 2b: Upsert by metadata matching (originalIndex)
 * - Example 3: Update item positions/queueIndex
 */
const loadAndConcatenateVideos = async () => {
  loadBtn.disabled = true;
  updateStatus('Initializing playlist database...', 'loading');

  cleanup();

  try {
    // Initialize Roll (it manages the Playlist internally)
    if (!roll) {
      const playlist = new Playlist('video-playlist-db', 'queue-items', 1);
      roll = new Roll(playlist, rollEntries);
      await roll.init();
    }

    // roll.setOnRollEnd(() => {
    //   // roll!.resetQueueIndex();
    //   updateStatus('Roll ended', 'info');
    // });

    // Check if playlist already has items (offline mode)
    const hasStoredItems = !(await roll.isEmpty());

    if (hasStoredItems) {
      const itemCount = await roll.length();
      updateStatus(`Loading ${itemCount} items from IndexedDB (offline)...`, 'loading');
      playoutBuffer = new PlayoutBuffer(videoElement);
    } else {
      // First time: fetch and store in IndexedDB through Roll using upsert
      updateStatus('Fetching videos and storing in IndexedDB (using upsert)...', 'loading');
      
      // Don't clear - we'll use upsert to handle existing items
      const upsertResults: Array<{ filename: string; result: Awaited<ReturnType<typeof roll.upsertItem>> }> = [];

      // Example 1: Upsert items by filename (will insert new or update existing)
      for (let i = 0; i < rollEntries.length; i += 1) {
        const entry = rollEntries[i];
        updateStatus(`Upserting segment ${i + 1}/${rollEntries.length}: ${entry.file}`, 'loading');
        
        try {
          const segment = await fetchSegment(entry.file, i);
          
          if (!segment.data) {
            throw new Error(`Segment ${segment.id} has no data`);
          }
          const blob = new Blob([segment.data], { type: 'video/mp4' });
          
          // Use upsertItemByFilename - will update if filename exists, insert if new
          const result = await roll.upsertItemByFilename(
            blob,
            entry.file,
            {
              originalIndex: i,
              streamId: segment.variant?.stream_id || 'main-stream',
              ...entry.metadata,
            },
            {
              queueIndex: entry.order, // Set position based on entry order
            }
          );
          
          upsertResults.push({ filename: entry.file, result });
          const action = result.inserted ? 'Inserted' : 'Updated';
          console.log(`${action} ${entry.file} in IndexedDB with id ${result.id}`);
        } catch (error) {
          console.error(`Failed to fetch ${entry.file}:`, error);
          // Try to load from IndexedDB if fetch fails (offline scenario)
          const items = await roll.getAllItems();
          const matchingItem = items.find(item => 
            (item.metadata.originalIndex as number) === i || 
            (item.metadata.filename as string) === entry.file
          );
          if (matchingItem) {
            updateStatus(`Loading ${entry.file} from IndexedDB (offline)...`, 'loading');
          } else {
            throw error;
          }
        }
      }

      // Example 2: Demonstrate batch upsert with a new item
      // Simulate adding a new item that wasn't in the original rollEntries
      const newEntry: RollEntry = { 
        file: './stacco.mp4', 
        order: 3, 
        metadata: { title: 'Stacco' } 
      };
      
      try {
        updateStatus('Batch upsert: Adding new item...', 'loading');
        const segment = await fetchSegment(newEntry.file, rollEntries.length);
        
        if (segment.data) {
          const blob = new Blob([segment.data], { type: 'video/mp4' });
          
          // Use batch upsert (single item in this case, but shows the pattern)
          const batchResults = await roll.upsertItems([
            {
              blob,
              metadata: {
                filename: newEntry.file,
                originalIndex: rollEntries.length,
                streamId: segment.variant?.stream_id || 'main-stream',
                ...newEntry.metadata,
              },
              options: {
                matchBy: {
                  fields: ['filename'],
                  values: [newEntry.file],
                },
                queueIndex: newEntry.order,
              },
            },
          ]);
          
          const batchResult = batchResults[0];
          const action = batchResult.inserted ? 'Inserted' : 'Updated';
          console.log(`Batch upsert: ${action} ${newEntry.file} with id ${batchResult.id}`);
        }
      } catch (error) {
        // File might not exist, that's okay for demo purposes
        console.log(`Note: ${newEntry.file} not available (this is expected if file doesn't exist)`);
      }

      // Example 2b: Demonstrate upsert with metadata matching (alternative to filename)
      // This shows matching by originalIndex instead of filename
      if (rollEntries.length > 0) {
        try {
          const entry = rollEntries[0];
          updateStatus('Upsert by metadata matching (originalIndex)...', 'loading');
          const segment = await fetchSegment(entry.file, 0);
          
          if (segment.data) {
            const blob = new Blob([segment.data], { type: 'video/mp4' });
            
            // Upsert by matching originalIndex instead of filename
            const result = await roll.upsertItem(
              blob,
              {
                filename: entry.file,
                originalIndex: 0,
                streamId: segment.variant?.stream_id || 'main-stream',
                ...entry.metadata,
                updatedAt: new Date().toISOString(), // Add timestamp to show metadata update
              },
              {
                matchBy: {
                  fields: ['originalIndex'],
                  values: [0],
                },
                updateBlob: true, // Update the blob as well
                mergeMetadata: true, // Merge with existing metadata
              }
            );
            
            const action = result.inserted ? 'Inserted' : 'Updated';
            console.log(`Metadata match upsert: ${action} item with originalIndex=0, id=${result.id}`);
          }
        } catch (error) {
          console.log('Metadata match upsert skipped (file not available)');
        }
      }

      // Example 3: Update positions of existing items
      updateStatus('Updating item positions...', 'loading');
      const allItems = await roll.getAllItems();
      
      // Simulate reordering: swap positions of first two items if they exist
      if (allItems.length >= 2) {
        const firstItem = allItems[0];
        const secondItem = allItems[1];
        
        if (firstItem.id !== undefined && secondItem.id !== undefined) {
          // Update positions using upsert with ID matching
          const firstBlob = firstItem.blob;
          const secondBlob = secondItem.blob;
          
          // Swap positions: first goes to position 1, second goes to position 0
          await roll.upsertItem(
            firstBlob,
            firstItem.metadata,
            {
              id: firstItem.id,
              queueIndex: 1, // Move to position 1
              updateBlob: false, // Don't update blob, just position
            }
          );
          
          await roll.upsertItem(
            secondBlob,
            secondItem.metadata,
            {
              id: secondItem.id,
              queueIndex: 0, // Move to position 0
              updateBlob: false, // Don't update blob, just position
            }
          );
          
          console.log('Position update: Swapped first two items');
        }
      }

      // Log summary of upsert operations
      const insertedCount = upsertResults.filter(r => r.result.inserted).length;
      const updatedCount = upsertResults.filter(r => !r.result.inserted).length;
      console.log(`Upsert summary: ${insertedCount} inserted, ${updatedCount} updated`);

      playoutBuffer = new PlayoutBuffer(videoElement);
    }

    updateStatus('Initializing buffer pipeline...', 'loading');
    await roll.attachBuffer(playoutBuffer!, videoElement);

    // Update ordering based on Roll data source
    try {
      updateStatus('Updating playlist ordering from data source...', 'loading');
      const updatedCount = await roll.updateOrdering();
      if (updatedCount > 0) {
        console.log(`Roll: Updated ordering for ${updatedCount} items`);
        updateStatus(`Ordering updated (${updatedCount} items). Reloading...`, 'loading');
        
        playoutBuffer?.close();
        playoutBuffer = new PlayoutBuffer(videoElement);
        updateStatus('Rebuilding buffer after ordering update...', 'loading');
        await roll.attachBuffer(playoutBuffer!, videoElement);
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    } catch (error) {
      console.error('Roll: Failed to update ordering:', error);
    }

    const finalState = playoutBuffer.getBufferState();
    const segmentsLoaded = (finalState.lastSegmentId ?? -1) + 1;
    const source = hasStoredItems ? 'IndexedDB (offline)' : 'network';
    updateStatus(
      `All queued (${segmentsLoaded}) from ${source}. Remaining: ${finalState.queueLength}`,
      'success'
    );

    playBtn.disabled = false;
    pauseBtn.disabled = false;
    resetBtn.disabled = false;
  } catch (error) {
    console.error('Playback queue failed', error);
    updateStatus(
      `Error queueing content: ${error instanceof Error ? error.message : 'unknown'}`,
      'error'
    );
  } finally {
    loadBtn.disabled = false;
  }
};

playBtn.addEventListener('click', async () => {
  try {
    await videoElement.play();
    updateStatus('Playing video', 'info');
  } catch (error) {
    console.error('Play failed', error);
    updateStatus('Play blocked (user interaction required)', 'error');
  }
});

pauseBtn.addEventListener('click', () => {
  videoElement.pause();
  updateStatus('Paused', 'info');
});

resetBtn.addEventListener('click', () => {
  videoElement.currentTime = 0;
  updateStatus('Reset to start', 'info');
});

window.addEventListener('beforeunload', () => {
  cleanup();
  if (roll) {
    roll.close();
    roll = null;
  }
});

loadBtn.addEventListener('click', loadAndConcatenateVideos);

// Initialize Roll on page load
(async () => {
  try {
    const playlist = new Playlist('video-playlist-db', 'queue-items', 1);
    roll = new Roll(playlist, rollEntries);
    await roll.init();
    const itemCount = await roll.length();
    if (itemCount > 0) {
      updateStatus(`Ready: ${itemCount} items in IndexedDB. Load to play (works offline).`, 'info');
    } else {
      updateStatus('Ready: load . to queue fragmented MP4 segments (will be stored in IndexedDB).', 'info');
    }
  } catch (error) {
    console.error('Failed to initialize Roll:', error);
    updateStatus('Ready: load . to queue fragmented MP4 segments.', 'info');
  }
})();

console.log('MP4 queue example ready with IndexedDB support');

