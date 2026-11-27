// UI module (page MAIN world): see src/ui.js.
// Verdicts, reasons, source descriptions and seek bar tooltip lines.

import { agoText, h, plural } from './dom.js';
import { settings, ui } from './state.js';

export const REPO = 'https://github.com/noahbds/vod-unmuter-extension';
const WHY_URL = REPO + '#how-long-twitch-keeps-the-original-audio';

// Short label of why a part is still muted (panel list).
export const REASON_SHORT = {
  gone: 'deleted by Twitch', skipped: 'deleted by Twitch', network: 'not checked yet',
  splice: 'sound didn\'t fit', damaged: 'saved copy unusable', checking: 'checking…',
};

export const QUALITY_LABEL = {
  original: 'Saved in original quality (lossless)',
  high: 'Saved in high quality (96 kbps)',
  small: 'Saved in small size (64 kbps)',
};

const endedAgo = (st) => (st && st.endedAt ? agoText(Date.now() - st.endedAt) : null);

// Full explanation (seek bar tooltip).
export function reasonText(reason, st) {
  const ago = endedAgo(st);
  switch (reason) {
    case 'gone':
      return `Twitch deleted the original sound here in every quality (checked: ${((st && st.checkedQualities) || []).join(', ') || 'all'}).` +
        (ago ? ` The stream ended ${ago}; Twitch deletes the originals 13 to 32 hours after a stream, and this part wasn't saved before that.` : '');
    case 'skipped':
      return `Not checked one by one: the stream ended ${ago || 'long ago'}, and none of ${(st && st.sampleSize) || 24} parts spread over the VOD still had its sound. ` +
        'Twitch deletes the originals 13 to 32 hours after a stream. It is still checked if you play it.';
    case 'network': return 'Twitch\'s video servers didn\'t answer when this part was checked. It is checked again automatically.';
    case 'splice': return 'The original sound was found, but its timing didn\'t match the video, so it is kept muted to avoid a glitch.';
    case 'damaged': return 'Your saved copy of this part couldn\'t be used, so it is kept muted.';
    default: return 'Still being checked.';
  }
}

export const mainReason = (r) => Object.entries((r && r.reasons) || {}).sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || 'gone';

// One or two lines on why the VOD isn't fully unmuted, most useful first.
export function verdictLines(st) {
  const r = (st && st.reasons) || {};
  const lines = [];
  const ago = endedAgo(st);
  const hours = st && st.endedAt ? (Date.now() - st.endedAt) / 36e5 : null;
  const gone = (r.gone || 0) + (r.skipped || 0);
  if (r.network) lines.push({ tone: 'wait', text: `${plural(r.network, 'part')} couldn't be checked: Twitch's video servers didn't answer. They are checked again automatically.` });
  if (gone) {
    let text;
    if (hours !== null && hours > 32) {
      text = `Twitch deleted the original sound of ${plural(gone, 'part')}: the stream ended ${ago}, and Twitch deletes it 13 to 32 hours after a stream. Only audio saved before then can bring it back.`;
    } else if (hours !== null) {
      text = `Twitch has started deleting this VOD's original sound (the stream ended ${ago}): ${plural(gone, 'part')} are already gone in every quality.` +
        (st.save && st.save.enabled ? ' The rest is being saved on this computer.' : '');
    } else {
      text = `Twitch deleted the original sound of ${plural(gone, 'part')} in every quality.`;
    }
    if (st.save && !st.save.enabled) text += ' Saving is off in the extension menu, so nothing is kept for later.';
    const channelName = st.channel;
    const followed = channelName && (settings.autoChannels || []).includes(channelName);
    if (followed && settings.saveAudio) text += ` Auto-save is on for ${channelName}: its next VODs are saved in time.`;
    const canSuggest = channelName && settings.saveAudio && !followed;
    lines.push({ tone: 'bad', text, why: true, suggest: canSuggest ? channelName : null });
  }
  if (r.splice || r.damaged) lines.push({ tone: 'bad', text: `${plural((r.splice || 0) + (r.damaged || 0), 'part')} had sound that couldn't be used (see the list).` });
  return lines;
}

export function verdictBox(st) {
  const lines = verdictLines(st);
  if (!lines.length) return null;
  return h('div', { class: 'vu-verdict' }, lines.map((l) => h('div', { class: 'vu-verdict-line vu-' + l.tone },
    l.text,
    l.why ? [' ', h('a', { class: 'vu-link', href: WHY_URL, target: '_blank', rel: 'noopener' }, 'Why?')] : null,
    l.suggest ? h('div', null, h('button', {
      class: 'vu-link', onclick: (e) => {
        e.stopPropagation();
        window.postMessage({ source: 'vod-unmuter-page', type: 'addAutoChannel', login: l.suggest }, location.origin);
        e.target.replaceWith(h('span', { class: 'vu-ok-c' }, `✓ New VODs from ${l.suggest} will be saved in time (auto-save).`));
      },
    }, `Auto-save ${l.suggest}'s next VODs`)) : null)));
}

const savedDate = (st) => {
  const s = st || ui.state;
  const t = s && s.save && s.save.savedAt;
  return t ? ' on ' + new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
};

// Plain-language description of where a part's sound comes from.
export function explainSource(src, st) {
  const s = st || ui.state;
  const watching = (s && s.quality) || 'this quality';
  switch (src.kind) {
    case 'original': return {
      color: '#22c55e', name: `Original ${src.quality} file`,
      why: 'The unmuted file for the quality you are watching still exists.' };
    case 'backup': return {
      color: '#22c55e', name: `Twitch's unmuted backup (${src.quality})`,
      why: 'A spare unmuted copy Twitch kept next to the muted file.' };
    case 'saved': return {
      color: '#a970ff', name: 'Saved copy on this computer',
      why: `Saved by the extension${savedDate(s)} while Twitch still had the original.` };
    case 'other': return {
      color: '#38bdf8',
      name: src.quality === 'audio_only' ? 'Sound from the audio-only version'
        : `Sound from the ${src.quality} version` + (/^(160|360)p/.test(src.quality) ? ' (lower sound quality)' : ''),
      why: `Deleted in ${watching}, still there in other qualities. Only the sound is borrowed; the picture stays ${watching}.` };
    default: return {
      color: '#38bdf8', name: `Sound from the ${src.quality} unmuted backup`,
      why: `Only the sound is borrowed; the picture stays ${watching}.` };
  }
}

// Hover text of the counter while checking: progress, then an early
// verdict from the spread-out sample and from how old the stream is.
export function checkingText(st, sample) {
  const lines = [`Checking muted segments: ${st.done || 0} of ${st.muted} done` +
    (st.found ? `, ${st.found} can be unmuted so far.` : '.')];
  if (sample) {
    if (!sample.found) {
      lines.push(`None of ${sample.size} segments spread over the whole VOD can be unmuted: ` +
        'the original sound looks deleted in every quality. Checking the rest to be sure…');
    } else {
      lines.push(`Early estimate: about ${Math.round((sample.found / sample.size) * 100)}% can be unmuted ` +
        `(${sample.found} of ${sample.size} segments spread over the VOD).`);
    }
  }
  if (st.endedAt) {
    const since = Date.now() - st.endedAt;
    if (since > (st.allGoneAfterH || 32) * 36e5) {
      lines.push(`The stream ended ${agoText(since)}. Twitch usually deletes the original sound ` +
        '13 to 32 hours after a stream, so only audio saved before then can still be restored.');
    }
  }
  return lines.join('\n\n');
}

// "Saved copy: …" line of the seek bar tooltip: is this part kept on this
// computer, for when Twitch deletes the original?
export function savedCopyText(r, st) {
  if (!r || r.kind === 'pending' || typeof r.saved !== 'number') return null;
  const s = st || ui.state || {};
  const sv = s.save || {};
  const n = r.segments;
  let text;
  if (r.saved >= n) text = 'yes';
  else if (r.saved > 0) text = `${r.saved} of ${n} segments`;
  else if ((r.removedWatched || 0) + (r.removedBehind || 0) >= n) text = r.removedBehind ? 'removed (you\'re past this part)' : 'removed after you watched it';
  else if (!sv.enabled) text = 'none (saving is off)';
  else if (!r.restored) text = 'none';
  else text = sv.mode === 'whole' ? 'not yet' : 'none';
  const removed = (r.removedWatched || 0) + (r.removedBehind || 0);
  if (r.saved > 0 && r.saved < n && removed) text += `, ${removed} removed (behind where you are)`;
  return text;
}

export function savedCopyLine(r, st) {
  const text = savedCopyText(r, st);
  return text ? h('div', { class: 'vu-src-why vu-saved-line' }, h('b', null, 'Saved copy: '), text) : null;
}

// "· via 720p60" when part of a range's sound comes from another quality.
export function viaText(r) {
  const others = [...new Set((r.sources || [])
    .filter((s) => s.kind === 'other' || s.kind === 'other-backup').map((s) => s.quality))];
  return others.length ? h('span', { class: 'vu-via' }, ` · via ${others.join(', ')}`) : null;
}
