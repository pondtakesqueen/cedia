# cedia

A personal coding harness in TypeScript on Bun. It pairs a top-tier model for planning (Claude) with cheaper models for writing code (DeepSeek, Haiku, beam-free), keeps the prompt cache warm, and backs every "done" with evidence it recorded itself.

Status: stage 1 of 6 (core, three wire formats, headless `bin/cedia -p` with read-only tools). See `SPEC.md` for decisions and stages, and `AGENTS.md` for how to work in this repo.

## License

Proprietary. All rights reserved. The source is public to read, but no one may use, copy, modify or distribute it without written permission from the owner. See `LICENSE`; adapted third-party code keeps its own license and is listed in `NOTICE`.
