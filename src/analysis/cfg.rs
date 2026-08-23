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
    let name = input.parse::<syn::Ident>()?.to_string();
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
