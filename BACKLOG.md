# Codefeed Development Backlog

This file tracks the planned features and improvements for the `codefeed` tool.

## Epic: Improve Summarization for Large Diffs

**Goal:** Rearchitect the summarization process to handle large diffs gracefully and provide more granular, useful summaries, working around the context limits of LLMs.

---

### Task 1: Intelligent Diff Filtering

*   **Description:** Modify the diff generation logic to exclude common noisy files (e.g., `package-lock.json`, `yarn.lock`) and asset files. This will immediately reduce the size of the diff sent to the AI and focus the analysis on meaningful code changes.
*   **Acceptance Criteria:**
    *   The `getGitDiff` function uses pathspecs to exclude a default list of patterns.
    *   The final diff provided to the summarizer does not contain changes from ignored files.
    *   (Optional) Users can add custom ignore patterns in `.codefeed/config.json`.

---

### Task 2: File-by-File Summarization

*   **Description:** Instead of summarizing an entire branch diff at once, the tool will first get a list of changed files and then generate a separate summary for the changes within each file. The final report will present a list of file-specific summaries.
*   **Acceptance Criteria:**
    *   The `runAnalysis` function is updated to iterate through changed files.
    *   The `summarizeChanges` function is adapted to handle a single file's diff.
    *   The final HTML report is redesigned to display summaries grouped by filename.

---

### Task 3: (Future) Implement Map-Reduce for Large File Diffs

*   **Description:** For cases where the diff of a *single file* is too large for the model's context window, implement a "map-reduce" strategy. This will involve:
    1.  **Map:** Splitting the file's diff into smaller, logical chunks and calling the AI model to summarize each chunk individually.
    2.  **Reduce:** Taking the collection of chunk summaries and making a second call to the AI model to create a final, coherent summary of the summaries.
*   **Acceptance Criteria:**
    *   A function exists to detect if a diff exceeds a certain token threshold.
    *   If it does, the diff is split into smaller chunks.
    *   The "map" step generates individual summaries for each chunk.
    *   The "reduce" step combines the individual summaries into a final summary.
