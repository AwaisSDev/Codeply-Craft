//! Settings > Skills: every skill the engine has (codeply-cli's built-in library, plugins' and
//! yours), searchable and filtered by where it came from. Only a page of rows is drawn at a time
//! ("Show more" adds the next), so 285 skills stay quick. "Use" starts a chat with `/name`.

use rune::{El, col, row, text, text_input};

use crate::app::{App, EditKey};
use crate::icons::ico_s;
use crate::model::{ButtonKind, Pill, Skill};
use crate::theme::{Theme, mono, ui};
use crate::ui::{btn, pill, tabs};

/// Rows drawn at first, and added by each "Show more".
pub const PAGE: usize = 40;
/// A description longer than this is cut (the full one is the skill's own).
const DESC: usize = 180;

/// The skills that match the search and the source picked, in name order.
pub fn matching<'a>(skills: &'a [Skill], query: &str, from: &str) -> Vec<&'a Skill> {
    let q = query.trim().to_lowercase();
    let words: Vec<&str> = q.split_whitespace().collect();
    let mut out: Vec<(u8, &Skill)> = skills.iter()
        .filter(|s| from.is_empty() || s.source == from)
        .filter_map(|s| {
            if words.is_empty() {
                return Some((0, s));
            }
            let name = s.name.to_lowercase();
            let all = format!("{name} {} {}", s.description.to_lowercase(), s.plugin.to_lowercase());
            if !words.iter().all(|w| all.contains(w)) {
                return None;
            }
            // Name hits first.
            Some((if name.starts_with(&q) { 0 } else if words.iter().all(|w| name.contains(w)) { 1 } else { 2 }, s))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.name.cmp(&b.1.name)));
    out.into_iter().map(|(_, s)| s).collect()
}

fn cut(s: &str) -> String {
    if s.chars().count() <= DESC {
        return s.to_owned();
    }
    let short: String = s.chars().take(DESC - 3).collect();
    format!("{}...", short.trim_end())
}

/// The page's groups (Settings puts its title above them).
pub fn groups(s: &App, t: &Theme) -> Vec<El> {
    let all = &s.data.extra.skills;
    let count = |from: &str| all.iter().filter(|k| k.source == from).count();
    let labels = [
        ("", format!("All {}", all.len())),
        ("built-in", format!("Built in {}", count("built-in"))),
        ("plugin", format!("Plugins {}", count("plugin"))),
        ("user", format!("Yours {}", count("user"))),
    ];
    let items: Vec<(&'static str, &str)> = labels.iter().map(|(k, l)| (*k, l.as_str())).collect();
    let search = row().h(36.0).grow(1.0).min_w(0.0).gap(8.0).px(10.0).radius(9.0).center_y().fill(t.field).border(1.0, t.field_border)
        .child(ico_s("search", 16.0, t.faint))
        .child(text_input(s.edit(EditKey::SkillSearch), ui(13.5, 400.0)).key("skill-search").single_line().grow(1.0).min_w(0.0).color(t.text)
            .placeholder("Search skills", t.faint).caret(t.accent, t.accent.alpha(0.3)).label("Search skills")
            .on_edit(|s: &mut App| s.edit_mut(EditKey::SkillSearch))
            // A new search starts from its first page.
            .on_input_change(|s: &mut App, _| s.skills_limit = PAGE));
    let bar = row().w_full().gap(10.0).center_y()
        .child(search)
        .child(tabs(t, "skills-from", &items, s.skills_from, |s: &mut App, v| { s.skills_from = v; s.skills_limit = PAGE; }));

    let query = s.edit(EditKey::SkillSearch).text.clone();
    let found = matching(all, &query, s.skills_from);
    let shown = found.len().min(s.skills_limit.max(PAGE));
    let mut rows: Vec<El> = found.iter().take(shown).map(|k| skill_row(t, k)).collect();
    if found.len() > shown {
        let more = found.len() - shown;
        rows.push(row().key("skills-more").w_full().h(44.0).px(16.0).center_y().hover(t.hover).role("button").label("Show more")
            .child(text(format!("Show {} more", more.min(PAGE))).font(ui(13.5, 500.0)).color(t.accent).grow(1.0))
            .child(text(format!("{shown} of {}", found.len())).font(ui(12.5, 400.0)).color(t.faint))
            .on_press(|s: &mut App| s.skills_limit = s.skills_limit.max(PAGE) + PAGE));
    }
    let title = if query.trim().is_empty() { "Skills".to_owned() } else { format!("{} found", found.len()) };
    let list = if rows.is_empty() {
        let why = if all.is_empty() { "No skills yet. They show here once the engine is up." } else { "No skills match." };
        crate::views::settings::group(t, &title, vec![row().w_full().px(16.0).py(18.0).child(text(why).font(ui(13.5, 400.0)).color(t.faint))])
    } else {
        crate::views::settings::group(t, &title, rows)
    };
    vec![
        bar,
        list,
        crate::views::settings::note(t, "Type / in any chat to use a skill: the engine reads it and follows it for that message. Add your own as a folder with a SKILL.md in ~/.codeply/skills."),
    ]
}

fn skill_row(t: &Theme, k: &Skill) -> El {
    let (label, kind) = match k.source.as_str() {
        "user" => (k.from_label(), Pill::Blue),
        "plugin" => (k.from_label(), Pill::Purple),
        _ => (k.from_label(), Pill::Gray),
    };
    let name = k.name.clone();
    row().key(format!("skill/{}", k.name)).w_full().px(16.0).py(12.0).gap(14.0).center_y().help(k.path.clone())
        .child(col().grow(1.0).min_w(0.0).gap(3.0)
            .child(row().gap(8.0).center_y()
                .child(text(format!("/{}", k.name)).font(mono(13.5, 18.0)).color(t.text).single_line())
                .child(pill(t, &label, kind)))
            .child(text(cut(&k.description)).font(ui(12.5, 400.0)).color(t.dim).wrap()))
        .child(btn(t, "Use", None, ButtonKind::Plain).key(format!("skill-use/{}", k.name)).on_press(move |s: &mut App| s.use_skill(&name)))
}

impl App {
    /// "Use" on a skill: a new chat with `/name ` ready in its composer.
    pub fn use_skill(&mut self, name: &str) {
        self.leave_settings();
        self.new_chat();
        self.edit_mut(EditKey::ChatHome).replace_text(format!("/{name} "));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(name: &str, description: &str, source: &str) -> Skill {
        Skill { name: name.into(), description: description.into(), source: source.into(), ..Default::default() }
    }

    #[test]
    fn search_and_source_narrow_the_list_names_first() {
        let all = vec![
            skill("tdd-workflow", "Test-driven development", "built-in"),
            skill("e2e-testing", "Playwright tests", "built-in"),
            skill("api-design", "REST design, with tests for each route", "built-in"),
            skill("pricing-copy", "How we write pricing pages", "user"),
        ];
        let names = |v: Vec<&Skill>| v.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(matching(&all, "", "")), ["api-design", "e2e-testing", "pricing-copy", "tdd-workflow"]);
        assert_eq!(names(matching(&all, "test", "")), ["e2e-testing", "api-design", "tdd-workflow"], "a name hit before a description hit");
        assert_eq!(names(matching(&all, "", "user")), ["pricing-copy"]);
        assert_eq!(names(matching(&all, "rest route", "")), ["api-design"], "every word must be there");
        assert!(matching(&all, "test", "user").is_empty());
        assert_eq!(cut(&"x".repeat(400)).chars().count(), DESC);
    }
}
