//! The code editor's keys: the suggestions popup (Up and Down pick, Tab or Enter take it, Esc
//! closes it, Ctrl Space asks for it), brackets and quotes that close themselves, Enter that
//! keeps the indent, and Tab that indents. What to suggest and how text changes is worked out
//! in `complete.rs`; this applies it to the editor.

use rune::{Key, KeyEvent, Mods, Tx};

use crate::app::{App, EditKey, View};
use crate::complete::{self, Change, Lang, Popup};

impl App {
    fn code_lang(&self) -> Lang {
        Lang::of(self.data.extra.code.open.as_deref().unwrap_or(""))
    }

    /// The suggestions popup, while it belongs to where the caret is.
    pub fn completion_shown(&self) -> Option<&Popup> {
        let p = self.completion.as_ref()?;
        let open = self.data.extra.code.open.as_deref()?;
        let (a, b) = self.edit(EditKey::Code).range();
        let fits = p.file == open && a == b && b == p.caret && !p.items.is_empty() && p.pick < p.items.len();
        (fits && self.view == View::Code && self.data.extra.code.proposal.is_none()).then_some(p)
    }

    fn apply_change(&mut self, c: Change) {
        let e = self.edit_mut(EditKey::Code);
        e.set_selection(c.from, c.to);
        e.insert(&c.insert);
        e.set_caret(c.caret);
        // Wisp's grey suggestion was for the text before.
        self.data.extra.code.suggestion = None;
    }

    /// The editor's text changed under your hands: a word being typed opens (or narrows) the
    /// suggestions, deleting narrows them, anything else closes them.
    pub fn code_typed(&mut self) {
        let lang = self.code_lang();
        let e = self.edit(EditKey::Code);
        let (a, b) = e.range();
        let (len, seen) = (e.text.len(), self.code_text_seen.len());
        let word = e.text.is_char_boundary(b) && e.text[..b].chars().next_back().is_some_and(|c| lang.word_char(c));
        let typing = a == b && word && len > seen && len - seen <= 4;
        let deleting = a == b && len < seen && self.completion.is_some();
        if typing || deleting {
            self.update_completion();
        } else {
            self.completion = None;
        }
    }

    /// Works out the suggestions for the word at the caret (none: the popup closes).
    pub fn update_completion(&mut self) {
        let Some(open) = self.data.extra.code.open.clone() else {
            self.completion = None;
            return;
        };
        let lang = self.code_lang();
        let e = self.edit(EditKey::Code);
        let caret = e.range().1;
        // The other open tabs' words too: what you typed in them, else their text as loaded.
        let tabs = self.tabs();
        let others: Vec<(&str, &str)> = tabs.iter().filter(|p| **p != open).filter_map(|p| {
            let text = self.code_drafts.get(p).or_else(|| self.code_others.get(p))?;
            Some((p.rsplit('/').next().unwrap_or(p), text.as_str()))
        }).collect();
        let (start, items) = complete::suggest(lang, &e.text, caret, &others);
        self.completion = (!items.is_empty()).then(|| Popup { file: open, start, caret, items, pick: 0 });
    }

    /// Puts the `i`th suggestion in place of the word typed so far.
    pub fn accept_completion(&mut self, i: usize) -> bool {
        let Some(p) = self.completion_shown().cloned() else { return false };
        let Some(item) = p.items.get(i) else { return false };
        let text = &self.edit(EditKey::Code).text;
        let unit = complete::indent_unit(self.code_lang(), text);
        let c = complete::accept(text, p.start, p.caret, item, &unit);
        self.completion = None;
        self.apply_change(c);
        true
    }

    /// The editor's own keys, before it types them. True when taken.
    pub fn code_key(&mut self, e: &KeyEvent, _tx: &mut Tx) -> bool {
        if self.data.extra.code.open.is_none() || self.edit(EditKey::Code).preedit().is_some() {
            return false;
        }
        let plain = e.mods == Mods::default();
        let shift_only = e.mods == Mods { shift: true, ..Mods::default() };
        if let Some(n) = self.completion_shown().map(|p| p.items.len()) {
            let pick = self.completion.as_ref().map_or(0, |p| p.pick);
            match e.key {
                Key::Up if plain => {
                    if let Some(p) = &mut self.completion {
                        p.pick = (pick + n - 1) % n;
                    }
                    return true;
                }
                Key::Down if plain => {
                    if let Some(p) = &mut self.completion {
                        p.pick = (pick + 1) % n;
                    }
                    return true;
                }
                Key::Tab | Key::Enter if plain => return self.accept_completion(pick),
                Key::Escape => {
                    self.completion = None;
                    return true;
                }
                _ => {}
            }
        }
        // Ctrl Space: the suggestions for the word at the caret, now.
        if e.is_command(' ') {
            self.update_completion();
            return true;
        }
        // Most keys type as usual: only these change how text goes in.
        let ours = match &e.key {
            Key::Tab | Key::Enter | Key::Backspace => true,
            Key::Text(s) => s.chars().count() == 1 && s.contains(['(', '[', '{', ')', ']', '}', '"', '\'', '`', '>']),
            _ => false,
        };
        if !ours {
            return false;
        }
        let lang = self.code_lang();
        let text = self.edit(EditKey::Code).text.clone();
        let range = self.edit(EditKey::Code).range();
        let unit = complete::indent_unit(lang, &text);
        let change = match &e.key {
            // Tab takes Wisp's grey suggestion when there is one, else indents.
            Key::Tab if plain => {
                if self.accept_suggestion() {
                    return true;
                }
                Some(complete::indent(&text, range, &unit))
            }
            Key::Tab if shift_only => complete::outdent(&text, range.1, &unit),
            Key::Enter if plain => Some(complete::enter(lang, &text, range, &unit)),
            Key::Backspace if plain => complete::backspace(&text, range),
            Key::Text(s) if !e.mods.cmd || e.mods.alt => {
                let mut chars = s.chars();
                match (chars.next(), chars.next()) {
                    (Some(c), None) => complete::typed(lang, &text, range, c),
                    _ => None,
                }
            }
            _ => None,
        };
        let Some(c) = change else {
            // Shift Tab with nothing to outdent stays in the editor.
            return matches!(e.key, Key::Tab) && shift_only;
        };
        self.completion = None;
        self.apply_change(c);
        true
    }
}
