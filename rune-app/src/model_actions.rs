//! What the app does with models: the handlers behind the composer's model menu and Settings >
//! Models. They go through `App::with_store`, so the mock store and the engine both answer.

use rune::TextEdit;

use crate::app::{App, SettingsPage};
use crate::models::{AUTO, ModelDraft, ModelOp};

impl App {
    /// Uses a model for new turns ("auto" is Haze 2). Closes the composer's menu.
    pub fn model_pick(&mut self, id: &str) {
        self.menu = None;
        let id = if id.is_empty() { AUTO.to_owned() } else { id.to_owned() };
        self.with_store(|st, d| st.models(ModelOp::Select(id), d));
    }

    /// Sets how hard a model thinks ("" is the provider's default).
    pub fn model_set_effort(&mut self, id: &str, effort: &str) {
        self.menu = None;
        let (id, effort) = (id.to_owned(), effort.to_owned());
        self.with_store(|st, d| st.models(ModelOp::Effort(id, effort), d));
    }

    /// The model menu opened: ask the provider which effort levels the picked model takes, once.
    pub fn model_menu_opened(&mut self) {
        let Some(m) = self.data.extra.models.current() else { return };
        if !m.has_effort() || m.effort_levels.is_some() || self.models_ui.asked.contains(&m.id) {
            return;
        }
        let id = m.id.clone();
        self.models_ui.asked.push(id.clone());
        self.with_store(|st, d| st.models(ModelOp::Levels(id), d));
    }

    pub fn model_open_form(&mut self, edit: Option<&str>) {
        let m = &mut self.data.extra.models;
        m.error = None;
        m.test_failed = false;
        self.models_ui.confirm = None;
        self.models_ui.open_form(&self.data.extra.models, edit);
    }

    /// "Add a model" from the composer's menu: Settings > Models, with the form open.
    pub fn model_add_from_menu(&mut self) {
        self.open_settings(SettingsPage::Models);
        self.model_open_form(None);
    }

    pub fn model_close_form(&mut self) {
        self.models_ui.close_form();
    }

    /// Test and save what the form holds (`skip_test`: save without the test request).
    pub fn model_submit(&mut self, skip_test: bool) {
        if self.data.extra.models.busy || !self.models_ui.open(&self.data.extra.models) {
            return;
        }
        let draft = self.models_ui.draft(skip_test);
        if let Some(why) = draft.problem() {
            self.data.extra.models.error = Some(why.to_owned());
            self.data.extra.models.test_failed = false;
            return;
        }
        self.with_store(|st, d| st.models(ModelOp::Save(draft), d));
        self.models_ui.tick(&self.data.extra.models);
    }

    /// Asks before removing: the first press arms the row's "Remove", the second removes it.
    pub fn model_delete(&mut self, id: &str) {
        if self.models_ui.confirm.as_deref() != Some(id) {
            self.models_ui.confirm = Some(id.to_owned());
            return;
        }
        self.models_ui.confirm = None;
        let id = id.to_owned();
        self.with_store(|st, d| st.models(ModelOp::Delete(id), d));
    }

    pub fn model_keep(&mut self) {
        self.models_ui.confirm = None;
    }

    pub fn model_phone(&mut self, id: &str, on: bool) {
        let id = id.to_owned();
        self.with_store(|st, d| st.models(ModelOp::Phone(id, on), d));
    }

    /// Looks for Ollama on this computer.
    pub fn model_scan(&mut self) {
        self.with_store(|st, d| st.models(ModelOp::ScanOllama, d));
    }

    /// Adds a model Ollama has pulled (it runs here: tested with a request, no key, not synced), or
    /// uses it when it is already added.
    pub fn model_add_local(&mut self, name: &str) {
        const HOST: &str = "http://localhost:11434";
        if let Some(m) = self.data.extra.models.list.iter().find(|m| m.kind == "ollama" && m.model == name && m.base_url == HOST) {
            let id = m.id.clone();
            return self.model_pick(&id);
        }
        let draft = ModelDraft {
            id: None, kind: "ollama".into(), name: format!("{name} (local)"), base_url: HOST.into(), model: name.to_owned(),
            api_key: Some(String::new()), phone: false, skip_test: false,
        };
        self.with_store(|st, d| st.models(ModelOp::Save(draft), d));
    }

    pub fn model_edit(&self, i: usize) -> &TextEdit {
        &self.models_ui.edits[i]
    }

    pub fn model_edit_mut(&mut self, i: usize) -> &mut TextEdit {
        &mut self.models_ui.edits[i]
    }
}
