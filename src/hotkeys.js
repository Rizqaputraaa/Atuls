// Key combinations as text, e.g. "Ctrl+Shift+A": the names are the ones uiohook uses for the keys on both Windows and macOS, so a
// combination recorded on one computer means the same keys when it is replayed there. Pure functions (no Electron), so they can be tested.

const MODS = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const MOD_OF = { Ctrl: 'Ctrl', CtrlRight: 'Ctrl', Alt: 'Alt', AltRight: 'Alt', Shift: 'Shift', ShiftRight: 'Shift', Meta: 'Meta', MetaRight: 'Meta' };
const isMod = (name) => Object.prototype.hasOwnProperty.call(MOD_OF, name);

// held modifier names (left/right variants allowed) + the pressed key -> "Ctrl+Alt+K"
function comboOf(heldNames, key) {
  const held = new Set([...heldNames].filter(isMod).map((n) => MOD_OF[n]));
  return [...MODS.filter((m) => held.has(m)), key].join('+');
}

// a key on its own is only a shortcut when it cannot be typed by mistake
const FREE_KEY = /^(F([1-9]|1\d|2[0-4])|Pause|PrintScreen|ScrollLock|NumLock|Insert|Menu)$/;
const needsModifier = (key) => !FREE_KEY.test(key);

// "Ctrl+Shift+A" -> { mods, key } or null; keyNames = the names the key injector knows
function parseCombo(text, keyNames) {
  if (typeof text !== 'string' || !text || text.length > 40) return null;
  const parts = text.split('+');
  const key = parts.pop();
  if (!key || isMod(key) || (keyNames && !keyNames.includes(key))) return null;
  const mods = [];
  for (const p of parts) { if (!MODS.includes(p) || mods.includes(p)) return null; mods.push(p); }
  if (!mods.length && needsModifier(key)) return null;
  // canonical order, so the same shortcut is always the same text
  return { mods: MODS.filter((m) => mods.includes(m)), key };
}
const normalCombo = (text, keyNames) => { const c = parseCombo(text, keyNames); return c ? [...c.mods, c.key].join('+') : null; };

// what a button or a keyboard shortcut can do: one of the named actions, or "keys:<combo>" = press that combination
const isKeysAction = (v) => typeof v === 'string' && v.startsWith('keys:');

// the list of keyboard shortcuts -> only valid, unique entries (at most 12)
function cleanHotkeys(list, keyNames, actionIds) {
  const out = [], seen = new Set();
  for (const h of Array.isArray(list) ? list : []) {
    const combo = normalCombo(h && h.combo, keyNames);
    if (!combo || seen.has(combo)) continue;
    let action = h.action;
    if (isKeysAction(action)) { const c = normalCombo(action.slice(5), keyNames); action = c ? 'keys:' + c : null; }
    else if (!actionIds.includes(action) || action === 'default' || action === 'none') action = null;
    if (!action) continue;
    seen.add(combo);
    out.push({ combo, action });
    if (out.length >= 12) break;
  }
  return out;
}

module.exports = { MODS, MOD_OF, isMod, comboOf, needsModifier, parseCombo, normalCombo, isKeysAction, cleanHotkeys };
