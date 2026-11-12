//! Active Rust target configuration.

use std::collections::{HashMap, HashSet};
use std::process::Command;

use anyhow::{Context, Result, bail};
use syn::{Attribute, LitStr, Meta};

#[derive(Debug, Clone)]
pub(super) struct CfgSet {
    flags: HashSet<String>,
    pairs: HashMap<String, HashSet<String>>,
}

impl CfgSet {
    pub(super) fn for_target(target: Option<&str>) -> Result<Self> {
        let mut command = Command::new("rustc");
        command.arg("--print").arg("cfg");
        if let Some(target) = target {
            command.arg("--target").arg(target);
        }
        let output = command.output().context("running rustc --print cfg")?;
        if !output.status.success() {
            bail!(
                "rustc --print cfg failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        Ok(Self::parse(&String::from_utf8_lossy(&output.stdout)))
    }

    fn parse(output: &str) -> Self {
        let mut flags = HashSet::new();
        let mut pairs: HashMap<String, HashSet<String>> = HashMap::new();
        for line in output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            if let Some((key, value)) = line.split_once('=') {
                pairs
                    .entry(key.to_owned())
                    .or_default()
                    .insert(value.trim_matches('"').to_owned());
            } else {
                flags.insert(line.to_owned());
            }
        }
        Self { flags, pairs }
    }

    fn eval(&self, expression: &CfgExpression) -> bool {
        match expression {
            CfgExpression::Flag(name) => self.flags.contains(name),
            CfgExpression::Pair(key, value) => self
                .pairs
                .get(key)
                .is_some_and(|values| values.contains(value)),
            CfgExpression::All(expressions) => {
                expressions.iter().all(|expression| self.eval(expression))
            }
            CfgExpression::Any(expressions) => {
                expressions.iter().any(|expression| self.eval(expression))
            }
            CfgExpression::Not(expression) => !self.eval(expression),
            CfgExpression::True => true,
            CfgExpression::False => false,
        }
    }
}

#[derive(Debug)]
enum CfgExpression {
    Flag(String),
    Pair(String, String),
    All(Vec<CfgExpression>),
    Any(Vec<CfgExpression>),
    Not(Box<CfgExpression>),
    True,
    False,
}

struct ParsedCfg(CfgExpression);

impl syn::parse::Parse for ParsedCfg {
    fn parse(input: syn::parse::ParseStream<'_>) -> syn::Result<Self> {
        Ok(Self(parse_expression(input)?))
    }
}

fn parse_expression(input: syn::parse::ParseStream<'_>) -> syn::Result<CfgExpression> {
    // `true` and `false` are keywords, which a plain identifier parse rejects.
    let name = input
        .call(<syn::Ident as syn::ext::IdentExt>::parse_any)?
        .to_string();
    if name == "not" {
        let content;
        syn::parenthesized!(content in input);
        return Ok(CfgExpression::Not(Box::new(parse_expression(&content)?)));
    }
    if name == "all" || name == "any" {
        let content;
        syn::parenthesized!(content in input);
        let mut expressions = Vec::new();
        while !content.is_empty() {
            expressions.push(parse_expression(&content)?);
            if content.peek(syn::Token![,]) {
                content.parse::<syn::Token![,]>()?;
            }
        }
        return Ok(if name == "all" {
            CfgExpression::All(expressions)
        } else {
            CfgExpression::Any(expressions)
        });
    }
    if name == "true" {
        return Ok(CfgExpression::True);
    }
    if name == "false" {
        return Ok(CfgExpression::False);
    }
    if input.peek(syn::Token![=]) {
        input.parse::<syn::Token![=]>()?;
        return Ok(CfgExpression::Pair(name, input.parse::<LitStr>()?.value()));
    }
    Ok(CfgExpression::Flag(name))
}

pub(super) fn active(cfg: &CfgSet, attributes: &[Attribute]) -> bool {
    attributes
        .iter()
        .filter(|attribute| attribute.path().is_ident("cfg"))
        .all(|attribute| {
            let Meta::List(list) = &attribute.meta else {
                return true;
            };
            syn::parse2::<ParsedCfg>(list.tokens.clone())
                .map(|parsed| cfg.eval(&parsed.0))
                .unwrap_or(true)
        })
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use serde_json::{Value, json};

    use super::*;
    use crate::lean_oracle;

    const FLAGS: [&str; 3] = ["unix", "test", "debug_assertions"];
    const KEYS: [&str; 2] = ["target_os", "feature"];
    const VALUES: [&str; 3] = ["linux", "macos", "std"];

    #[derive(Debug, Clone)]
    enum Predicate {
        Flag(&'static str),
        Pair(&'static str, &'static str),
        Bool(bool),
        All(Vec<Predicate>),
        Any(Vec<Predicate>),
        Not(Box<Predicate>),
    }

    impl Predicate {
        /// As written in a `#[cfg(...)]` attribute.
        fn render(&self) -> String {
            let list = |name: &str, items: &[Predicate]| {
                let items = items.iter().map(Self::render).collect::<Vec<_>>();
                format!("{name}({})", items.join(", "))
            };
            match self {
                Self::Flag(flag) => (*flag).to_owned(),
                Self::Pair(key, value) => format!("{key} = \"{value}\""),
                Self::Bool(value) => value.to_string(),
                Self::All(items) => list("all", items),
                Self::Any(items) => list("any", items),
                Self::Not(item) => format!("not({})", item.render()),
            }
        }

        /// As the Lean oracle reads it.
        fn to_json(&self) -> Value {
            let list = |items: &[Predicate]| items.iter().map(Self::to_json).collect::<Value>();
            match self {
                Self::Flag(flag) => json!({ "flag": flag }),
                Self::Pair(key, value) => json!({ "pair": [key, value] }),
                Self::Bool(value) => json!({ "bool": value }),
                Self::All(items) => json!({ "all": list(items) }),
                Self::Any(items) => json!({ "any": list(items) }),
                Self::Not(item) => json!({ "not": item.to_json() }),
            }
        }
    }

    fn predicate() -> impl Strategy<Value = Predicate> {
        let leaf = prop_oneof![
            prop::sample::select(&FLAGS[..]).prop_map(Predicate::Flag),
            (
                prop::sample::select(&KEYS[..]),
                prop::sample::select(&VALUES[..])
            )
                .prop_map(|(key, value)| Predicate::Pair(key, value)),
            any::<bool>().prop_map(Predicate::Bool),
        ];
        leaf.prop_recursive(4, 24, 4, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..4).prop_map(Predicate::All),
                prop::collection::vec(inner.clone(), 0..4).prop_map(Predicate::Any),
                inner.prop_map(|item| Predicate::Not(Box::new(item))),
            ]
        })
    }

    fn configuration()
    -> impl Strategy<Value = (Vec<&'static str>, Vec<(&'static str, &'static str)>)> {
        let pairs = (
            prop::sample::select(&KEYS[..]),
            prop::sample::select(&VALUES[..]),
        );
        (
            prop::sample::subsequence(&FLAGS[..], 0..=FLAGS.len()),
            prop::collection::vec(pairs, 0..4),
        )
    }

    proptest! {
        /// Parsing a written predicate and evaluating it agrees with what the
        /// Lean oracle (`cfg/oracle/Cfg.lean`) says it means.
        #[test]
        fn evaluates_predicates_as_the_oracle_does(
            predicate in predicate(),
            (flags, pairs) in configuration(),
        ) {
            let written = predicate.render();
            let parsed = syn::parse_str::<ParsedCfg>(&written);
            prop_assert!(parsed.is_ok(), "`{}` did not parse", written);
            let set = CfgSet {
                flags: flags.iter().map(|flag| (*flag).to_owned()).collect(),
                pairs: pairs.iter().fold(HashMap::new(), |mut set: HashMap<String, HashSet<String>>, (key, value)| {
                    set.entry((*key).to_owned()).or_default().insert((*value).to_owned());
                    set
                }),
            };
            let query = json!({
                "query": "cfg",
                "flags": flags,
                "pairs": pairs.iter().map(|(key, value)| [key, value]).collect::<Vec<_>>(),
                "predicate": predicate.to_json(),
            });
            if let Some(answer) = lean_oracle::ask(&query) {
                prop_assert_eq!(set.eval(&parsed.unwrap().0), answer["holds"] == true, "for `{}`", written);
            }
        }
    }
}
