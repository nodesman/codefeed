# Codefeed 🚀

AI-powered git history summaries, right in your browser. Codefeed is a CLI tool that analyzes your git repository's recent changes and generates clear, high-level summaries for each branch and file, helping you quickly understand the evolution of your codebase.

![Codefeed Screenshot](https://user-images.githubusercontent.com/12345/67890.png)
*(Screenshot placeholder: A beautiful image of the Codefeed dashboard would go here.)*

## What is Codefeed?

Tired of deciphering long, complex git logs? Codefeed connects to powerful AI models (like Google's Gemini and OpenAI's GPT) to do the heavy lifting for you.

Run a single command in your repository, and Codefeed will:
- **Analyze recent commits** on your main and current branches.
- **Generate a high-level summary** of the overall changes.
- **Provide a detailed summary for each modified file**, focusing on the "why" behind the changes, not just the "what".
- **Launch a local web dashboard** for you to interactively explore the analysis.

## Features

- **🤖 AI-Powered Summaries:** Leverages generative AI to create human-readable explanations of your code changes.
- **🌐 Interactive Dashboard:** A clean, local web UI to browse different analysis runs and branches.
- **📄 Detailed Diff Viewer:** A GUI-style diff viewer for each file, showing additions and deletions in a clear, hunk-by-hunk format.
- **🧠 Smart Analysis:** Automatically detects the commit range since your last `git pull` and analyzes your local work.
- **⚡️ Efficient:** Caches analyses to avoid re-processing the same commit ranges, saving you time and API calls.
- **⚙️ Configurable:** Choose your preferred AI model (`gemini-2.5-flash`, `gpt-5`, etc.) during the initial setup.

## How It Works

Codefeed is designed to analyze the work you've done locally before you push it.

1.  It fetches the latest updates from your `origin` remote.
2.  It intelligently finds the last point you synced with the remote (using the `reflog`).
3.  It then generates a diff between that last sync point and your current `HEAD`.

#### ✔️ Local Commits are Included
Because Codefeed analyzes the commits up to your current `HEAD`, **it will include all local commits you have made**, even if you haven't pushed them to the remote repository yet. This is perfect for summarizing your work before creating a pull request.

#### ❌ Unstaged Changes are Not Included
Codefeed operates on your repository's commit history. Therefore, **it does not see or analyze any unstaged or uncommitted changes**. Always commit your work before running `codefeed` to ensure it's included in the analysis.

## Installation

```bash
npm install -g codefeed
```
*(Note: This assumes the package name on npm will be `codefeed`.)*

## Usage

1.  Navigate to your git repository:
    ```bash
    cd /path/to/your/project
    ```
2.  Run the command:
    ```bash
    codefeed
    ```
3.  The first time you run it, you'll be prompted to choose a default AI model.
4.  Your browser will open with the dashboard, and the analysis will begin. You can browse previous analyses while the new one is running.

## Configuration

Codefeed requires an API key for the AI model you choose. This must be set as an environment variable.

- For Gemini models: `GEMINI_API_KEY`
- For GPT models: `OPENAI_API_KEY`

Your model preference is stored locally in a `.codefeed/config.json` file in your project's root directory.

## License

This project is licensed under the MIT License.
