import type { WebContainer } from '@webcontainer/api';
import { atom } from 'nanostores';
import { bufferWatchEvents } from '~/utils/buffer';

// Extend Window interface to include our custom property
declare global {
  interface Window {
    _tabId?: string;
  }
}

export interface PreviewInfo {
  port: number;
  ready: boolean;
  baseUrl: string;
}

// Create a broadcast channel for preview updates
const PREVIEW_CHANNEL = 'preview-updates';

export class PreviewsStore {
  #availablePreviews = new Map<number, PreviewInfo>();
  #webcontainer: Promise<WebContainer>;
  #broadcastChannel: BroadcastChannel;
  #lastUpdate = new Map<string, number>();
  #watchedFiles = new Set<string>();
  #refreshTimeouts = new Map<string, NodeJS.Timeout>();
  #REFRESH_DELAY = 300;
  #storageChannel: BroadcastChannel;

  previews = atom<PreviewInfo[]>([]);

  constructor(webcontainerPromise: Promise<WebContainer>) {
    this.#webcontainer = webcontainerPromise;
    this.#broadcastChannel = new BroadcastChannel(PREVIEW_CHANNEL);
    this.#storageChannel = new BroadcastChannel('storage-sync-channel');

    this.#setupBroadcastChannels();
    this.#setupLocalStorageOverride();
    this.#init();
  }

  async #init() {
    const webcontainer = await this.#webcontainer;

    webcontainer.on('server-ready', (port, url) => {
      console.log('[Preview] Server ready on port:', port, url);
      this.broadcastUpdate(url);
      this._broadcastStorageSync();
    });

    try {
      webcontainer.fs.watch(
        '**/*',
        bufferWatchEvents(300, (_events) => {
          const previews = this.previews.get();

          for (const preview of previews) {
            const previewId = this.getPreviewId(preview.baseUrl);

            if (previewId) {
              this.broadcastFileChange(previewId);
            }
          }
        }),
      );
    } catch (error) {
      console.error('[Preview] Error setting up watchers:', error);
    }

    this.#setupDOMObserver();
    this.#setupPortListener(webcontainer);
  }

  #setupBroadcastChannels() {
    this.#broadcastChannel.onmessage = (event) => {
      const { type, previewId, timestamp } = event.data;

      if (type === 'file-change') {
        const lastUpdate = this.#lastUpdate.get(previewId) || 0;

        if (timestamp > lastUpdate) {
          this.#lastUpdate.set(previewId, timestamp);
          this.refreshPreview(previewId);
        }
      }
    };

    this.#storageChannel.onmessage = (event) => {
      const { storage, source } = event.data;

      if (storage && source !== this._getTabId()) {
        this._syncStorage(storage);
      }
    };
  }

  #setupLocalStorageOverride() {
    if (typeof window !== 'undefined') {
      const originalSetItem = localStorage.setItem.bind(localStorage);

      localStorage.setItem = (...args) => {
        originalSetItem(...args);
        this._broadcastStorageSync();
      };
    }
  }

  #setupDOMObserver() {
    if (typeof window !== 'undefined') {
      const observer = new MutationObserver(() => {
        this._broadcastStorageSync();
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    }
  }

  #setupPortListener(webcontainer: WebContainer) {
    webcontainer.on('port', (port, type, url) => {
      const previews = this.previews.get();
      let previewInfo = this.#availablePreviews.get(port);

      if (type === 'close' && previewInfo) {
        this.#availablePreviews.delete(port);
        this.previews.set(previews.filter((p) => p.port !== port));

        return;
      }

      if (!previewInfo) {
        previewInfo = { port, ready: type === 'open', baseUrl: url };
        this.#availablePreviews.set(port, previewInfo);
        previews.push(previewInfo);
      }

      previewInfo.ready = type === 'open';
      previewInfo.baseUrl = url;

      this.previews.set([...previews]);

      if (type === 'open') {
        this.broadcastUpdate(url);
      }
    });
  }

  // Generate a unique ID for this tab
  private _getTabId(): string {
    if (typeof window !== 'undefined') {
      if (!window._tabId) {
        window._tabId = Math.random().toString(36).substring(2, 15);
      }

      return window._tabId;
    }

    return '';
  }

  // Sync storage data between tabs
  private _syncStorage(storage: Record<string, string>) {
    if (typeof window !== 'undefined') {
      Object.entries(storage).forEach(([key, value]) => {
        try {
          const originalSetItem = Object.getPrototypeOf(localStorage).setItem;
          originalSetItem.call(localStorage, key, value);
        } catch (error) {
          console.error('[Preview] Error syncing storage:', error);
        }
      });

      // Force a refresh after syncing storage
      const previews = this.previews.get();
      previews.forEach((preview) => {
        const previewId = this.getPreviewId(preview.baseUrl);

        if (previewId) {
          this.refreshPreview(previewId);
        }
      });

      // Reload the page content
      if (typeof window !== 'undefined' && window.location) {
        const iframe = document.querySelector('iframe');

        if (iframe) {
          iframe.src = iframe.src;
        }
      }
    }
  }

  // Broadcast storage state to other tabs
  private _broadcastStorageSync() {
    if (typeof window !== 'undefined') {
      const storage: Record<string, string> = {};

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);

        if (key) {
          storage[key] = localStorage.getItem(key) || '';
        }
      }

      this.#storageChannel.postMessage({
        type: 'storage-sync',
        storage,
        source: this._getTabId(),
        timestamp: Date.now(),
      });
    }
  }

  // Helper to extract preview ID from URL
  getPreviewId(url: string): string | null {
    const match = url.match(/^https?:\/\/([^.]+)\.local-credentialless\.webcontainer-api\.io/);
    return match ? match[1] : null;
  }

  // Broadcast state change to all tabs
  broadcastStateChange(previewId: string) {
    const timestamp = Date.now();
    this.#lastUpdate.set(previewId, timestamp);

    this.#broadcastChannel.postMessage({
      type: 'state-change',
      previewId,
      timestamp,
    });
  }

  // Broadcast file change to all tabs
  broadcastFileChange(previewId: string) {
    const timestamp = Date.now();
    this.#lastUpdate.set(previewId, timestamp);

    this.#broadcastChannel.postMessage({
      type: 'file-change',
      previewId,
      timestamp,
    });
  }

  // Broadcast update to all tabs
  broadcastUpdate(url: string) {
    const previewId = this.getPreviewId(url);

    if (previewId) {
      const timestamp = Date.now();
      this.#lastUpdate.set(previewId, timestamp);

      this.#broadcastChannel.postMessage({
        type: 'file-change',
        previewId,
        timestamp,
      });
    }
  }

  // Method to refresh a specific preview
  refreshPreview(previewId: string) {
    // Clear any pending refresh for this preview
    const existingTimeout = this.#refreshTimeouts.get(previewId);

    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set a new timeout for this refresh
    const timeout = setTimeout(() => {
      const previews = this.previews.get();
      const preview = previews.find((p) => this.getPreviewId(p.baseUrl) === previewId);

      if (preview) {
        preview.ready = false;
        this.previews.set([...previews]);

        requestAnimationFrame(() => {
          preview.ready = true;
          this.previews.set([...previews]);
        });
      }

      this.#refreshTimeouts.delete(previewId);
    }, this.#REFRESH_DELAY);

    this.#refreshTimeouts.set(previewId, timeout);
  }
}

// Create a singleton instance
let previewsStore: PreviewsStore | null = null;

export function usePreviewStore() {
  if (!previewsStore) {
    /*
     * Initialize with a Promise that resolves to WebContainer
     * This should match how you're initializing WebContainer elsewhere
     */
    previewsStore = new PreviewsStore(Promise.resolve({} as WebContainer));
  }

  return previewsStore;
}
