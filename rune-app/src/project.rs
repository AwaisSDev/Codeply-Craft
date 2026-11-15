//! The project folder: opening another one (the code view's and the Pull requests page's "Open
//! folder"), remembering it for the next launch, and the Pull requests page's git and GitHub
//! actions (initialize, clone, sign in, install the GitHub CLI, publish).

use rune::Tx;

use crate::app::{App, EditKey, View};
use crate::model::PrOp;

/// A folder's name from its path (either slash), or the path itself for a drive root.
pub fn folder_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed.rsplit(['/', '\\']).next().filter(|n| !n.is_empty()).unwrap_or(path).to_owned()
}

/// Where GitHub's device sign-in asks for the code `gh auth login --web` prints.
const GITHUB_DEVICE: &str = "https://github.com/login/device";

impl App {
    /// "Open folder": pick a folder and make it the project.
    pub fn open_project(&mut self, tx: &mut Tx) {
        let here = &self.data.extra.project_path;
        let options = rune::FileDialogOptions {
            title: "Open a project folder".into(),
            directory: (!here.is_empty()).then(|| std::path::PathBuf::from(here)),
            ..Default::default()
        };
        tx.open_folder(options, |s: &mut App, result, _| match result {
            Ok(Some(path)) => s.set_project(&path.to_string_lossy()),
            Ok(None) => {}
            Err(e) => s.notice = Some(format!("Couldn't open the folder picker: {e}")),
        });
    }

    /// Makes `path` the project folder (remembered for the next launch); the file tree, its open
    /// files and pull requests start over there.
    pub fn set_project(&mut self, path: &str) {
        self.prefs.project = path.to_owned();
        self.prefs.save();
        self.data.extra.code.open = None;
        self.data.extra.code.saved.clear();
        self.data.extra.code.review.clear();
        self.data.extra.code.suggestion = None;
        self.data.extra.code.proposal = None;
        self.data.extra.pr_files = None;
        self.code_tabs.clear();
        self.code_drafts.clear();
        self.code_loaded = None;
        self.edit_mut(EditKey::Code).clear();
        self.pr = 0;
        self.store.set_project(path, &mut self.data);
    }

    /// The code view's Refresh: the file list again, and the open file from disk.
    pub fn refresh_code(&mut self) {
        self.store.refresh_files();
        if let Some(p) = self.data.extra.code.open.clone() {
            self.open_file(&p);
        }
    }

    /// Runs `cmd` in the project folder with the terminal pane open, so you can watch it.
    pub fn run_in_terminal(&mut self, cmd: &str) {
        self.panes.terminal = true;
        self.store.run_command(cmd, &mut self.data);
    }

    /// Sign in to GitHub: `gh auth login` in the terminal (it prints a one-time code), and
    /// GitHub's device page in the browser to type it into.
    pub fn github_sign_in(&mut self, tx: &mut Tx) {
        self.run_in_terminal("gh auth login --web --git-protocol https --hostname github.com");
        let _ = tx.open_url(GITHUB_DEVICE);
    }

    /// Installs the GitHub CLI (winget on Windows), or opens its download page elsewhere.
    pub fn install_gh(&mut self, tx: &mut Tx) {
        if cfg!(windows) {
            self.run_in_terminal("winget install --id GitHub.cli -e --source winget --accept-package-agreements --accept-source-agreements");
        } else {
            let _ = tx.open_url("https://cli.github.com");
        }
    }

    /// Clones what's in the clone field (a URL or `owner/name`); it opens as the project when done.
    pub fn clone_repo(&mut self) {
        let url = self.edit(EditKey::CloneUrl).text.trim().to_owned();
        if url.is_empty() {
            self.notice = Some("Paste a repository URL, like https://github.com/you/app.".into());
            return;
        }
        self.edit_mut(EditKey::CloneUrl).clear();
        self.prs_op(PrOp::Clone(url));
    }

    /// A clone that finished opens as the project (called from `poll`).
    pub fn step_project(&mut self) -> bool {
        let Some(path) = self.store.take_project() else { return false };
        self.set_project(&path);
        if self.view != View::Prs && self.view != View::Code {
            self.go(View::Code);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::folder_name;

    #[test]
    fn folder_names() {
        assert_eq!(folder_name("C:\\Users\\sam\\Codeply\\site"), "site");
        assert_eq!(folder_name("/home/sam/app/"), "app");
        assert_eq!(folder_name("C:\\"), "C:");
    }
}
