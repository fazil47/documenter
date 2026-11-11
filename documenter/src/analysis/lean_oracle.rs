//! The Lean oracles' answers, for differential tests: one driver process
//! (`oracle_driver/Main.lean`), built once with Lake and shared by every test.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

struct Driver {
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

/// The oracles' answer to `query`, or `None` when Lean is not installed.
pub(super) fn ask(query: &Value) -> Option<Value> {
    static DRIVER: OnceLock<Option<Mutex<Driver>>> = OnceLock::new();
    let driver = DRIVER.get_or_init(start).as_ref()?;
    let mut driver = driver
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    writeln!(driver.input, "{query}").expect("writing to the Lean oracle");
    let mut line = String::new();
    driver
        .output
        .read_line(&mut line)
        .expect("reading from the Lean oracle");
    let answer: Value = serde_json::from_str(&line).expect("the Lean oracle answers JSON");
    assert!(
        answer.get("error").is_none(),
        "the Lean oracle refused {query}: {answer}"
    );
    Some(answer)
}

fn start() -> Option<Mutex<Driver>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the crate is in the workspace");
    let built = Command::new("lake").arg("build").current_dir(root).output();
    match built {
        Err(_) => {
            eprintln!("skipped Lean oracle checks: lake is not installed");
            return None;
        }
        Ok(built) if !built.status.success() => panic!(
            "building the Lean oracles failed:\n{}",
            String::from_utf8_lossy(&built.stdout)
        ),
        Ok(_) => {}
    }
    let mut child = Command::new(root.join(".lake/build/bin/oracle"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("starting the Lean oracle");
    let input = child.stdin.take().expect("piped stdin");
    let output = BufReader::new(child.stdout.take().expect("piped stdout"));
    Some(Mutex::new(Driver {
        _child: child,
        input,
        output,
    }))
}
