import { NostrDeliveryInbox, NostrRelayClient, normalizeRelayUrl } from '../dist/index.js';
const url = normalizeRelayUrl('wss://relay.example.com/');
if (url !== 'wss://relay.example.com') process.exit(1);
if (typeof NostrDeliveryInbox !== 'function') process.exitCode ||= 1;
if (typeof NostrRelayClient !== 'function') process.exitCode ||= 1;
console.log('nostr-delivery consumer OK');
