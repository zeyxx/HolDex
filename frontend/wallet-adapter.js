/**
 * Wallet Adapter - Vanilla JS Implementation
 *
 * Silent-first wallet detection for Wallet Standard compliant wallets
 * - Detects Phantom, Solflare, Backpack without throwing errors
 * - Framework-agnostic (works with React, Vue, vanilla JS, etc)
 * - Graceful degradation: shows "wallet not found" instead of crashing
 *
 * Usage (vanilla JS):
 *   const adapter = new WalletAdapter();
 *   adapter.detectWallets();
 *   if (adapter.hasPhantom) { adapter.connectPhantom(); }
 */

class WalletAdapter {
    constructor() {
        this.wallets = {
            phantom: null,
            solflare: null,
            backpack: null
        };

        this.detectedWallets = [];
        this.currentProvider = null;
        this.publicKey = null;
        this.connected = false;

        // Event listeners
        this.listeners = {
            connect: [],
            disconnect: [],
            accountChange: []
        };
    }

    /**
     * Silently detect installed wallets (no errors thrown)
     * Returns array of detected wallet names
     */
    detectWallets() {
        this.detectedWallets = [];

        // Check for Phantom
        if (this._isPhantomInstalled()) {
            this.wallets.phantom = window.phantom?.solana;
            this.detectedWallets.push('phantom');
        }

        // Check for Solflare
        if (this._isSolflareInstalled()) {
            this.wallets.solflare = window.solflare;
            this.detectedWallets.push('solflare');
        }

        // Check for Backpack
        if (this._isBackpackInstalled()) {
            this.wallets.backpack = window.backpack?.solana;
            this.detectedWallets.push('backpack');
        }

        return this.detectedWallets;
    }

    /**
     * Private: Check if Phantom is installed
     */
    _isPhantomInstalled() {
        return !!window.phantom?.solana;
    }

    /**
     * Private: Check if Solflare is installed
     */
    _isSolflareInstalled() {
        return !!window.solflare;
    }

    /**
     * Private: Check if Backpack is installed
     */
    _isBackpackInstalled() {
        return !!window.backpack?.solana;
    }

    /**
     * Public: Connect to Phantom
     */
    async connectPhantom() {
        if (!this.wallets.phantom) {
            throw new Error('Phantom wallet not installed');
        }

        try {
            const response = await this.wallets.phantom.connect();
            this.currentProvider = this.wallets.phantom;
            this.publicKey = response.publicKey.toString();
            this.connected = true;

            this._emit('connect', { publicKey: this.publicKey, wallet: 'phantom' });
            return { publicKey: this.publicKey, wallet: 'phantom' };
        } catch (err) {
            throw new Error(`Failed to connect Phantom: ${err.message}`);
        }
    }

    /**
     * Public: Connect to Solflare
     */
    async connectSolflare() {
        if (!this.wallets.solflare) {
            throw new Error('Solflare wallet not installed');
        }

        try {
            const response = await this.wallets.solflare.connect();
            this.currentProvider = this.wallets.solflare;
            this.publicKey = response.publicKey.toString();
            this.connected = true;

            this._emit('connect', { publicKey: this.publicKey, wallet: 'solflare' });
            return { publicKey: this.publicKey, wallet: 'solflare' };
        } catch (err) {
            throw new Error(`Failed to connect Solflare: ${err.message}`);
        }
    }

    /**
     * Public: Connect to Backpack
     */
    async connectBackpack() {
        if (!this.wallets.backpack) {
            throw new Error('Backpack wallet not installed');
        }

        try {
            const response = await this.wallets.backpack.connect();
            this.currentProvider = this.wallets.backpack;
            this.publicKey = response.publicKey.toString();
            this.connected = true;

            this._emit('connect', { publicKey: this.publicKey, wallet: 'backpack' });
            return { publicKey: this.publicKey, wallet: 'backpack' };
        } catch (err) {
            throw new Error(`Failed to connect Backpack: ${err.message}`);
        }
    }

    /**
     * Public: Disconnect current wallet
     */
    async disconnect() {
        if (!this.currentProvider) return;

        try {
            await this.currentProvider.disconnect();
            this.currentProvider = null;
            this.publicKey = null;
            this.connected = false;

            this._emit('disconnect');
        } catch (err) {
            console.warn(`Disconnect error: ${err.message}`);
        }
    }

    /**
     * Public: Sign a message
     */
    async signMessage(message) {
        if (!this.currentProvider) {
            throw new Error('Wallet not connected');
        }

        try {
            const encodedMessage = new TextEncoder().encode(message);
            const response = await this.currentProvider.signMessage(encodedMessage);
            return {
                signature: response.signature,
                publicKey: this.publicKey
            };
        } catch (err) {
            throw new Error(`Failed to sign message: ${err.message}`);
        }
    }

    /**
     * Public: Request to sign a transaction
     */
    async signTransaction(transaction) {
        if (!this.currentProvider) {
            throw new Error('Wallet not connected');
        }

        try {
            const signedTx = await this.currentProvider.signTransaction(transaction);
            return signedTx;
        } catch (err) {
            throw new Error(`Failed to sign transaction: ${err.message}`);
        }
    }

    /**
     * Public: Get detected wallets
     */
    getDetectedWallets() {
        return this.detectedWallets;
    }

    /**
     * Public: Check if any wallet detected
     */
    hasDetectedWallets() {
        return this.detectedWallets.length > 0;
    }

    /**
     * Public: Get human-readable status
     */
    getStatus() {
        return {
            connected: this.connected,
            publicKey: this.publicKey,
            detectedWallets: this.detectedWallets,
            currentProvider: this.currentProvider ? 'connected' : 'disconnected'
        };
    }

    /**
     * Event handling: on
     */
    on(event, callback) {
        if (this.listeners[event]) {
            this.listeners[event].push(callback);
        }
    }

    /**
     * Event handling: off
     */
    off(event, callback) {
        if (this.listeners[event]) {
            this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
        }
    }

    /**
     * Private: Emit event
     */
    _emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(cb => cb(data));
        }
    }
}

// Export for both CommonJS and ESM
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WalletAdapter;
}
