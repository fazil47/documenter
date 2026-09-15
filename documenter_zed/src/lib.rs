use zed_extension_api as zed;

const SERVER_BINARY: &str = "documenter";

struct DocumenterExtension;

impl zed::Extension for DocumenterExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<zed::Command> {
        let command = worktree.which(SERVER_BINARY).ok_or_else(|| {
            "documenter was not found in PATH; install it from the checked-out Documenter repository"
                .to_owned()
        })?;

        Ok(zed::Command {
            command,
            args: vec!["lsp".to_owned()],
            env: worktree.shell_env(),
        })
    }
}

zed::register_extension!(DocumenterExtension);
