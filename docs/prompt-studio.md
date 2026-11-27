# Prompt Studio

Open **Prompt Studio** and choose a Claude model. Describe the task, generate a draft, and edit the result before copying it or inserting it into the selected terminal. Insert leaves the draft for you to submit. If the terminal cannot accept the complete draft safely, AgentDock copies it for you to paste when ready.

Draft generation uses the installed Claude Code CLI in your selected Ubuntu distribution, with your existing Claude subscription sign-in. The model selector passes the chosen alias or exact model ID to Claude Code. The account must have access to that model. Sign in through the normal Claude Code flow in Ubuntu if prompted. [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)

The CLI starts in an empty temporary directory with tools, plugins, custom instructions, MCP servers and local session persistence disabled. Only the text in **Prompt request** is sent as your task input. A draft runs on demand and uses your Claude subscription limits. You can stop it from the panel or close the panel to cancel. Prompts and drafts are held in memory in AgentDock. [Claude Code data usage](https://code.claude.com/docs/en/data-usage)
