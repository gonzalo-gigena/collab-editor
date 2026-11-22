import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

// Closes where retrying can't help: the same content would be sent, and rejected, again.
// 4400 and 4413 come from sync, 1009 from the WebSocket message limit.
const FATAL = { 4400: 'the server rejected a malformed update', 4413: 'the document is too large', 1009: 'that edit is too large' };

const doc = new Y.Doc();
const provider = new HocuspocusProvider({
  // Not just /ws/: the provider strips trailing slashes, and /ws doesn't match Caddy's /ws/*.
  url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/sync`,
  name: 'default', // ponytail: one document, the same name as DOC in sync, until phase 3
  document: doc,
});

const extensions = [
  StarterKit.configure({ undoRedo: false }), // Collaboration has its own undo, which skips other people's edits
  Collaboration.configure({ document: doc }),
];

function App() {
  const [fatal, setFatal] = useState();
  const editor = useEditor({
    extensions,
    editorProps: { attributes: { role: 'textbox', 'aria-label': 'Document', 'aria-multiline': 'true' } },
  });

  useEffect(() => {
    const onClose = ({ event }) => {
      if (!FATAL[event.code]) return;
      provider.disconnect();
      editor.setEditable(false);
      setFatal(FATAL[event.code]);
    };
    provider.on('close', onClose);
    return () => provider.off('close', onClose);
  }, [editor]);

  return (
    <main>
      <h1>Collaborative editor</h1>
      {fatal && <p role="alert">Editing stopped: {fatal}. Copy what you need, then reload.</p>}
      <EditorContent editor={editor} />
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
