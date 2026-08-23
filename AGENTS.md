# AGENT Preferences

- Err on the side of simplicity when writing code. If a decision depends on user preference, use the brainstorming skill to ask.
- Before making any change, state what you think the user wants.
- Prefer deep, cohesive modules that hide substantial implementation behind a small public API.
- Expose only what consumers actually need. Keep implementation details private.
- After implementation, use a separate sub-agent review pass to check module depth and unnecessary exposure, then address its findings before finishing.
