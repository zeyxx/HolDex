/**
 * useWallet - React Hook for Wallet Adapter
 *
 * Provides React-friendly wallet management
 *
 * Usage:
 *   const { connected, publicKey, wallets, connect, disconnect, signMessage } = useWallet();
 *
 *   if (!wallets.length) return <div>No wallet detected. Install Phantom</div>;
 *   if (!connected) return <button onClick={() => connect('phantom')}>Connect Wallet</button>;
 *
 *   return <div>Connected: {publicKey}</div>;
 */

import { useState, useEffect, useCallback } from 'react';
import WalletAdapter from './wallet-adapter';

// Singleton adapter instance
let adapterInstance = null;

function getAdapterInstance() {
    if (!adapterInstance && typeof window !== 'undefined') {
        adapterInstance = new WalletAdapter();
        adapterInstance.detectWallets();
    }
    return adapterInstance;
}

function useWallet() {
    const [connected, setConnected] = useState(false);
    const [publicKey, setPublicKey] = useState(null);
    const [detectedWallets, setDetectedWallets] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);

    const adapter = getAdapterInstance();

    // Initialize on mount
    useEffect(() => {
        if (adapter) {
            const wallets = adapter.getDetectedWallets();
            setDetectedWallets(wallets);

            // Listen for connection changes
            const onConnect = (data) => {
                setConnected(true);
                setPublicKey(data.publicKey);
                setError(null);
            };

            const onDisconnect = () => {
                setConnected(false);
                setPublicKey(null);
            };

            adapter.on('connect', onConnect);
            adapter.on('disconnect', onDisconnect);

            return () => {
                adapter.off('connect', onConnect);
                adapter.off('disconnect', onDisconnect);
            };
        }
    }, []);

    /**
     * Connect to a specific wallet
     */
    const connect = useCallback(async (walletName) => {
        if (!adapter) return;

        setIsLoading(true);
        setError(null);

        try {
            switch (walletName) {
                case 'phantom':
                    await adapter.connectPhantom();
                    break;
                case 'solflare':
                    await adapter.connectSolflare();
                    break;
                case 'backpack':
                    await adapter.connectBackpack();
                    break;
                default:
                    throw new Error(`Unknown wallet: ${walletName}`);
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setIsLoading(false);
        }
    }, []);

    /**
     * Disconnect current wallet
     */
    const disconnect = useCallback(async () => {
        if (!adapter) return;

        try {
            await adapter.disconnect();
        } catch (err) {
            setError(err.message);
        }
    }, []);

    /**
     * Sign a message
     */
    const signMessage = useCallback(async (message) => {
        if (!adapter) {
            throw new Error('Adapter not initialized');
        }

        try {
            return await adapter.signMessage(message);
        } catch (err) {
            setError(err.message);
            throw err;
        }
    }, []);

    /**
     * Sign a transaction
     */
    const signTransaction = useCallback(async (transaction) => {
        if (!adapter) {
            throw new Error('Adapter not initialized');
        }

        try {
            return await adapter.signTransaction(transaction);
        } catch (err) {
            setError(err.message);
            throw err;
        }
    }, []);

    return {
        connected,
        publicKey,
        detectedWallets,
        isLoading,
        error,
        connect,
        disconnect,
        signMessage,
        signTransaction
    };
}

export default useWallet;
