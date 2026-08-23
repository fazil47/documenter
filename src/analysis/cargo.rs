//! Cargo package discovery.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

#[derive(Debug, Clone)]
pub(super) struct Package {
    pub(super) name: String,
    pub(super) lib_crate_name: Option<String>,
    pub(super) lib_rs: Option<PathBuf>,
    pub(super) main_rs: Option<PathBuf>,
}

impl Package {
    pub(super) fn crate_root(&self) -> String {
        self.lib_crate_name
            .clone()
            .unwrap_or_else(|| rustc_crate_name(&self.name))
    }

    pub(super) fn local_aliases(&self) -> Vec<String> {
        let mut names = vec![self.name.clone(), rustc_crate_name(&self.name)];
        if let Some(lib) = &self.lib_crate_name {
            names.push(lib.clone());
        }
        names.sort();
        names.dedup();
        names
    }
}

pub(super) fn find_root(start: &Path) -> Result<PathBuf> {
    let start = start
        .canonicalize()
        .with_context(|| format!("workspace path not found: {}", start.display()))?;
    for directory in start.ancestors() {
        if directory.join("Cargo.toml").is_file() {
            return Ok(directory.to_path_buf());
        }
    }
    bail!("no Cargo.toml at or above {}", start.display())
}

pub(super) fn discover_packages(codebase: &Path) -> Result<Vec<Package>> {
    let manifest = codebase.join("Cargo.toml");
    let text = std::fs::read_to_string(&manifest)
        .with_context(|| format!("reading {}", manifest.display()))?;
    let value: toml::Value =
        toml::from_str(&text).with_context(|| format!("parsing {}", manifest.display()))?;

    if let Some(workspace) = value.get("workspace") {
        let members = workspace
            .get("members")
            .and_then(toml::Value::as_array)
            .context("workspace Cargo.toml missing [workspace].members")?;
        let mut packages = Vec::new();
        for member in members {
            let relative = member
                .as_str()
                .context("workspace member must be a string path")?;
            if relative.contains('*') {
                continue;
            }
            if let Some(package) = package_from_dir(&codebase.join(relative))? {
                packages.push(package);
            }
        }
        if packages.is_empty() {
            bail!("no analyzable packages in {}", codebase.display());
        }
        return Ok(packages);
    }

    package_from_dir(codebase)?.map_or_else(
        || Err(anyhow::anyhow!("no Rust target in {}", codebase.display())),
        |package| Ok(vec![package]),
    )
}

fn package_from_dir(directory: &Path) -> Result<Option<Package>> {
    let manifest = directory.join("Cargo.toml");
    if !manifest.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&manifest)
        .with_context(|| format!("reading {}", manifest.display()))?;
    let value: toml::Value =
        toml::from_str(&text).with_context(|| format!("parsing {}", manifest.display()))?;
    let Some(package) = value.get("package") else {
        return Ok(None);
    };
    let name = package
        .get("name")
        .and_then(toml::Value::as_str)
        .with_context(|| format!("missing package.name in {}", manifest.display()))?
        .to_owned();

    let source = directory.join("src");
    let lib_rs = source
        .join("lib.rs")
        .is_file()
        .then(|| source.join("lib.rs"));
    let main_rs = source
        .join("main.rs")
        .is_file()
        .then(|| source.join("main.rs"));
    if lib_rs.is_none() && main_rs.is_none() {
        return Ok(None);
    }

    let lib_crate_name = lib_rs.as_ref().map(|_| {
        value
            .get("lib")
            .and_then(|library| library.get("name"))
            .and_then(toml::Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| rustc_crate_name(&name))
    });

    Ok(Some(Package {
        name,
        lib_crate_name,
        lib_rs,
        main_rs,
    }))
}

fn rustc_crate_name(name: &str) -> String {
    name.replace('-', "_")
}
