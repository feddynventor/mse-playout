import { QueueItem, QueueItemMetadata } from './types/database';

/**
 * Playlist class that manages a queue of media items stored in IndexedDB
 * Designed for use with a media player
 */
export class Playlist {
  private dbName: string;
  private storeName: string;
  private dbVersion: number;
  private db: IDBDatabase | null = null;
  private currentIndex: number = -1;

  /**
   * Creates a new Playlist instance
   * @param dbName - Name of the IndexedDB database
   * @param storeName - Name of the object store
   * @param dbVersion - Database version (increment to trigger upgrade)
   */
  constructor(dbName: string = 'playlist-db', storeName: string = 'queue-items', dbVersion: number = 1) {
    this.dbName = dbName;
    this.storeName = storeName;
    this.dbVersion = dbVersion;
  }

  /**
   * Initializes the IndexedDB database
   * Must be called before using other methods
   */
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        reject(new Error(`Failed to open database: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // Create object store if it doesn't exist
        if (!db.objectStoreNames.contains(this.storeName)) {
          const objectStore = db.createObjectStore(this.storeName, {
            keyPath: 'id',
            autoIncrement: true,
          });
          
          // Create index on queueIndex for efficient queue ordering
          objectStore.createIndex('queueIndex', 'queueIndex', { unique: false });
        }
      };
    });
  }

  /**
   * Gets the database instance, initializing if necessary
   */
  private async getDB(): Promise<IDBDatabase> {
    if (!this.db) {
      await this.init();
    }
    if (!this.db) {
      throw new Error('Database initialization failed');
    }
    return this.db;
  }

  /**
   * Adds an item to the queue
   * @param blob - The file blob to store
   * @param metadata - Optional metadata for the item
   * @param insertIndex - Optional position to insert at (defaults to end)
   */
  async add(blob: Blob, metadata: QueueItemMetadata = {}, insertIndex?: number): Promise<number> {
    const db = await this.getDB();
    const transaction = db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    const index = store.index('queueIndex');

    return new Promise((resolve, reject) => {
      // Get the current maximum queueIndex
      const countRequest = index.count();
      
      countRequest.onsuccess = async () => {
        try {
          const maxIndex = countRequest.result;
          const queueIndex = insertIndex !== undefined 
            ? Math.max(0, Math.min(insertIndex, maxIndex))
            : maxIndex;

          // If inserting in the middle, shift existing items first
          if (insertIndex !== undefined && insertIndex < maxIndex) {
            await this.shiftQueueIndices(transaction, insertIndex, 1);
          }
          
          const item: QueueItem = {
            blob,
            queueIndex,
            metadata,
          };

          const addRequest = store.add(item);
          
          addRequest.onsuccess = () => {
            resolve(addRequest.result as number);
          };
          
          addRequest.onerror = () => {
            reject(new Error(`Failed to add item: ${addRequest.error?.message}`));
          };
        } catch (error) {
          reject(error);
        }
      };

      countRequest.onerror = () => {
        reject(new Error(`Failed to get queue count: ${countRequest.error?.message}`));
      };
    });
  }

  /**
   * Shifts queue indices when inserting or removing items
   */
  private shiftQueueIndices(transaction: IDBTransaction, fromIndex: number, shift: number): Promise<void> {
    const store = transaction.objectStore(this.storeName);
    const index = store.index('queueIndex');
    const range = IDBKeyRange.lowerBound(fromIndex);

    return new Promise((resolve, reject) => {
      let pendingUpdates = 0;
      let hasError = false;

      const cursorRequest = index.openCursor(range);

      cursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cursor) {
          const item = cursor.value as QueueItem;
          if (item.queueIndex >= fromIndex) {
            pendingUpdates++;
            const updatedItem: QueueItem = {
              ...item,
              queueIndex: item.queueIndex + shift,
            };
            
            const updateRequest = cursor.update(updatedItem);
            updateRequest.onsuccess = () => {
              pendingUpdates--;
              if (pendingUpdates === 0 && !hasError) {
                resolve();
              }
            };
            updateRequest.onerror = () => {
              hasError = true;
              reject(new Error(`Failed to update queue index: ${updateRequest.error?.message}`));
            };
          }
          cursor.continue();
        } else {
          // No more items to process
          if (pendingUpdates === 0 && !hasError) {
            resolve();
          }
        }
      };

      cursorRequest.onerror = () => {
        hasError = true;
        reject(new Error(`Failed to shift queue indices: ${cursorRequest.error?.message}`));
      };
    });
  }

  /**
   * Removes an item from the queue by ID
   */
  async remove(id: number): Promise<void> {
    const db = await this.getDB();
    const transaction = db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);

    return new Promise((resolve, reject) => {
      // First, get the item to know its queueIndex
      const getRequest = store.get(id);
      
      getRequest.onsuccess = () => {
        const item = getRequest.result as QueueItem | undefined;
        if (!item) {
          reject(new Error(`Item with id ${id} not found`));
          return;
        }

        const queueIndex = item.queueIndex;

        // Delete the item
        const deleteRequest = store.delete(id);
        
        deleteRequest.onsuccess = () => {
          // Shift remaining items
          this.shiftQueueIndices(transaction, queueIndex + 1, -1)
            .then(() => resolve())
            .catch(reject);
        };
        
        deleteRequest.onerror = () => {
          reject(new Error(`Failed to remove item: ${deleteRequest.error?.message}`));
        };
      };

      getRequest.onerror = () => {
        reject(new Error(`Failed to get item: ${getRequest.error?.message}`));
      };
    });
  }

  /**
   * Gets the current item in the queue
   */
  async current(): Promise<QueueItem | null> {
    if (this.currentIndex < 0) {
      return null;
    }

    const items = await this.getAll();
    return items[this.currentIndex] || null;
  }

  /**
   * Moves to the next item in the queue
   * @param loop - Whether to loop back to the beginning when reaching the end
   * @returns The next item or null if at the end
   */
  async next(loop: boolean = false): Promise<QueueItem | null> {
    const items = await this.getAll();
    
    if (items.length === 0) {
      this.currentIndex = -1;
      return null;
    }

    if (this.currentIndex < items.length - 1) {
      this.currentIndex++;
      return items[this.currentIndex];
    } else if (loop) {
      this.currentIndex = 0;
      return items[0];
    }

    return null;
  }

  /**
   * Moves to the previous item in the queue
   * @param loop - Whether to loop to the end when at the beginning
   * @returns The previous item or null if at the beginning
   */
  async previous(loop: boolean = false): Promise<QueueItem | null> {
    const items = await this.getAll();
    
    if (items.length === 0) {
      this.currentIndex = -1;
      return null;
    }

    if (this.currentIndex > 0) {
      this.currentIndex--;
      return items[this.currentIndex];
    } else if (loop) {
      this.currentIndex = items.length - 1;
      return items[this.currentIndex];
    }

    return null;
  }

  /**
   * Jumps to a specific index in the queue
   */
  async jumpTo(index: number): Promise<QueueItem | null> {
    const items = await this.getAll();
    
    if (index >= 0 && index < items.length) {
      this.currentIndex = index;
      return items[index];
    }

    return null;
  }

  /**
   * Gets an item by its ID
   */
  async getItem(id: number): Promise<QueueItem | null> {
    const db = await this.getDB();
    const transaction = db.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);

    return new Promise((resolve, reject) => {
      const request = store.get(id);
      
      request.onsuccess = () => {
        resolve(request.result as QueueItem || null);
      };
      
      request.onerror = () => {
        reject(new Error(`Failed to get item: ${request.error?.message}`));
      };
    });
  }

  /**
   * Gets all items in the queue, sorted by queueIndex
   */
  async getAll(): Promise<QueueItem[]> {
    const db = await this.getDB();
    const transaction = db.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);
    const index = store.index('queueIndex');

    return new Promise((resolve, reject) => {
      const request = index.getAll();
      
      request.onsuccess = () => {
        const items = request.result as QueueItem[];
        // Ensure items are sorted by queueIndex
        items.sort((a, b) => a.queueIndex - b.queueIndex);
        resolve(items);
      };
      
      request.onerror = () => {
        reject(new Error(`Failed to get all items: ${request.error?.message}`));
      };
    });
  }

  /**
   * Gets the number of items in the queue
   */
  async length(): Promise<number> {
    const db = await this.getDB();
    const transaction = db.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);

    return new Promise((resolve, reject) => {
      const request = store.count();
      
      request.onsuccess = () => {
        resolve(request.result);
      };
      
      request.onerror = () => {
        reject(new Error(`Failed to get queue length: ${request.error?.message}`));
      };
    });
  }

  /**
   * Checks if the queue is empty
   */
  async isEmpty(): Promise<boolean> {
    const length = await this.length();
    return length === 0;
  }

  /**
   * Clears all items from the queue
   */
  async clear(): Promise<void> {
    const db = await this.getDB();
    const transaction = db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);

    return new Promise((resolve, reject) => {
      const request = store.clear();
      
      request.onsuccess = () => {
        this.currentIndex = -1;
        resolve();
      };
      
      request.onerror = () => {
        reject(new Error(`Failed to clear queue: ${request.error?.message}`));
      };
    });
  }

  /**
   * Gets the current index position in the queue
   */
  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /**
   * Resets the current index to the beginning
   */
  reset(): void {
    this.currentIndex = -1;
  }

  /**
   * Reorders items by swapping their queue indices
   */
  async reorder(fromIndex: number, toIndex: number): Promise<void> {
    const db = await this.getDB();
    const transaction = db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    const index = store.index('queueIndex');

    return new Promise((resolve, reject) => {
      const getAllRequest = index.getAll();
      
      getAllRequest.onsuccess = () => {
        const items = getAllRequest.result as QueueItem[];
        items.sort((a, b) => a.queueIndex - b.queueIndex);

        if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length) {
          reject(new Error('Invalid indices for reordering'));
          return;
        }

        // Swap queue indices
        const temp = items[fromIndex].queueIndex;
        items[fromIndex].queueIndex = items[toIndex].queueIndex;
        items[toIndex].queueIndex = temp;

        // Update both items
        const updatePromises = [
          new Promise<void>((resolveUpdate, rejectUpdate) => {
            const update1 = store.put(items[fromIndex]);
            update1.onsuccess = () => resolveUpdate();
            update1.onerror = () => rejectUpdate(update1.error);
          }),
          new Promise<void>((resolveUpdate, rejectUpdate) => {
            const update2 = store.put(items[toIndex]);
            update2.onsuccess = () => resolveUpdate();
            update2.onerror = () => rejectUpdate(update2.error);
          }),
        ];

        Promise.all(updatePromises)
          .then(() => resolve())
          .catch(reject);
      };

      getAllRequest.onerror = () => {
        reject(new Error(`Failed to reorder items: ${getAllRequest.error?.message}`));
      };
    });
  }

  /**
   * Updates metadata for an item
   */
  async updateMetadata(id: number, metadata: Partial<QueueItemMetadata>): Promise<void> {
    const db = await this.getDB();
    const transaction = db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);

    return new Promise((resolve, reject) => {
      const getRequest = store.get(id);
      
      getRequest.onsuccess = () => {
        const item = getRequest.result as QueueItem | undefined;
        if (!item) {
          reject(new Error(`Item with id ${id} not found`));
          return;
        }

        const updatedItem: QueueItem = {
          ...item,
          metadata: { ...item.metadata, ...metadata },
        };

        const updateRequest = store.put(updatedItem);
        
        updateRequest.onsuccess = () => {
          resolve();
        };
        
        updateRequest.onerror = () => {
          reject(new Error(`Failed to update metadata: ${updateRequest.error?.message}`));
        };
      };

      getRequest.onerror = () => {
        reject(new Error(`Failed to get item: ${getRequest.error?.message}`));
      };
    });
  }

  /**
   * Updates an entire item (blob, metadata, queueIndex)
   * @param id - The item ID
   * @param updates - Partial item with fields to update
   */
  async updateItem(id: number, updates: Partial<QueueItem>): Promise<void> {
    const db = await this.getDB();
    const transaction = db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);

    return new Promise((resolve, reject) => {
      const getRequest = store.get(id);
      
      getRequest.onsuccess = () => {
        const item = getRequest.result as QueueItem | undefined;
        if (!item) {
          reject(new Error(`Item with id ${id} not found`));
          return;
        }

        const updatedItem: QueueItem = {
          ...item,
          ...updates,
          // Merge metadata if provided
          metadata: updates.metadata
            ? { ...item.metadata, ...updates.metadata }
            : item.metadata,
        };

        const updateRequest = store.put(updatedItem);
        
        updateRequest.onsuccess = () => {
          resolve();
        };
        
        updateRequest.onerror = () => {
          reject(new Error(`Failed to update item: ${updateRequest.error?.message}`));
        };
      };

      getRequest.onerror = () => {
        reject(new Error(`Failed to get item: ${getRequest.error?.message}`));
      };
    });
  }

  /**
   * Updates the queueIndex of an item
   * @param id - The item ID
   * @param newQueueIndex - The new queue index position
   */
  async updateQueueIndex(id: number, newQueueIndex: number): Promise<void> {
    const db = await this.getDB();
    const transaction = db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);

    return new Promise((resolve, reject) => {
      const getRequest = store.get(id);
      
      getRequest.onsuccess = () => {
        const item = getRequest.result as QueueItem | undefined;
        if (!item) {
          reject(new Error(`Item with id ${id} not found`));
          return;
        }

        const updatedItem: QueueItem = {
          ...item,
          queueIndex: newQueueIndex,
        };

        const updateRequest = store.put(updatedItem);
        
        updateRequest.onsuccess = () => {
          resolve();
        };
        
        updateRequest.onerror = () => {
          reject(new Error(`Failed to update queueIndex: ${updateRequest.error?.message}`));
        };
      };

      getRequest.onerror = () => {
        reject(new Error(`Failed to get item: ${getRequest.error?.message}`));
      };
    });
  }

  /**
   * Batch updates queue indices for multiple items
   * @param updates - Array of {id, queueIndex} pairs to update
   */
  async batchUpdateQueueIndices(updates: Array<{ id: number; queueIndex: number }>): Promise<void> {
    const db = await this.getDB();
    const transaction = db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);

    const updatePromises = updates.map(({ id, queueIndex }) => {
      return new Promise<void>((resolve, reject) => {
        const getRequest = store.get(id);
        
        getRequest.onsuccess = () => {
          const item = getRequest.result as QueueItem | undefined;
          if (!item) {
            reject(new Error(`Item with id ${id} not found`));
            return;
          }

          const updatedItem: QueueItem = {
            ...item,
            queueIndex,
          };

          const updateRequest = store.put(updatedItem);
          
          updateRequest.onsuccess = () => {
            resolve();
          };
          
          updateRequest.onerror = () => {
            reject(new Error(`Failed to update queueIndex for item ${id}: ${updateRequest.error?.message}`));
          };
        };

        getRequest.onerror = () => {
          reject(new Error(`Failed to get item ${id}: ${getRequest.error?.message}`));
        };
      });
    });

    await Promise.all(updatePromises);
  }

  /**
   * Closes the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

