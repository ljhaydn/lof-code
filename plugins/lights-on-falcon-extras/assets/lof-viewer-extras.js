  async function updateTonightPanel() {
    const body = document.getElementById('lof-tonight-body');
    if (!body) return;
  
    // We still call showDetails so this panel updates on the same cadence
    // as the rest of the viewer, but we no longer branch on RF modes or
    // queue length here. This block is about tone, not mechanics.
    try {
      await fetchShowDetails();
    } catch (e) {
      // If RF is unreachable, we simply fall back to the default copy below.
      console.warn('[LOF] tonight panel showDetails error (non-fatal):', e);
    }
  
    const lines = [];
  
    // Core mission / vibe copy for the footer
    const defaultTonightBody = [
      'You’ve dropped into a neighborhood light show built by real families on Falcon Avenue.',
      'Pick a song, send a Glow, or just soak it in — you’re part of tonight’s story.',
      'We’re a tiny street, so thanks for being kind to the block, patient with the chaos, and generous with your joy.'
    ].join(' ');
  
    const tonightBody = texts.tonightBody || defaultTonightBody;
    lines.push(tonightBody);
  
    // Optional acts-of-light / kindness prompt
    const kindness = chooseRandomLine(texts.kindnessPrompts);
    if (kindness) {
      lines.push('Tiny mission (if you want one): ' + kindness);
    }
  
    // Optional footer tag line from settings
    if (texts.copyFooter) {
      lines.push(texts.copyFooter);
    }
  
    body.innerHTML = lines
      .map(l => '<p>' + escapeHtml(l) + '</p>')
      .join('');
  }