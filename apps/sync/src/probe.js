// Used by restart-check.sh.
//   node src/probe.js <url> write <text>   insert text, print "acked" once the server has it,
//                                          then exit when the server drops the socket (no reconnect,
//                                          so the text can't come back from this client)
//   node src/probe.js <url> read <text>    exit 0 if a fresh client sees text in the document
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { DOC } from './server.js';

const [url, mode, text] = process.argv.slice(2);
const provider = new HocuspocusProvider({ url, name: DOC, document: new Y.Doc() });
provider.on('synced', () => {
  const t = provider.document.getText('t');
  if (mode === 'read') {
    const found = t.toString().includes(text);
    console.log(found ? `found "${text}"` : `MISSING "${text}"`);
    process.exit(found ? 0 : 1);
  }
  provider.on('unsyncedChanges', () => provider.hasUnsyncedChanges || console.log('acked'));
  provider.on('close', () => process.exit(0));
  t.insert(0, text);
});
setTimeout(() => { console.log('timed out'); process.exit(2); }, 60_000);
