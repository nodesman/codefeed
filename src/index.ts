#!/usr/bin/env node

import { Command } from 'commander';
import { simpleGit, SimpleGit } from 'simple-git';
import axios from 'axios';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import http from 'http';
import open from 'open';
import portfinder from 'portfinder';
import os from 'os';

const program = new Command();
const git: SimpleGit = simpleGit();

const CONFIG_DIR = '.codefeed';
const CONFIG_FILE = 'config.json';

interface Config {
  model: string;
  exclude?: string[];
}

interface FileSummary {
    file: string;
    summary: string;
}

interface BranchSummary {
    branch: string;
    summaries: FileSummary[];
    noisyChanges: string[];
    from: string;
    to: string;
}

async function runAnalysis(): Promise<BranchSummary[]> {
    const gitRoot = await git.revparse(['--show-toplevel']);
    
    const remotes = await git.getRemotes();
    if (!remotes.some(remote => remote.name === 'origin')) {
        throw new Error("This repository does not have a remote named 'origin'. Please add one to continue.");
    }

    const config = await getConfiguration(gitRoot);
    
    console.log('Fetching latest changes...');
    await git.fetch();

    const branches = await getBranchesToAnalyze();
    const branchSummaries: BranchSummary[] = [];
    
    for (const branch of branches) {
      const remoteBranch = `origin/${branch}`;
      console.log(`\nAnalyzing branch: ${branch}`);

      const to = await git.revparse([remoteBranch]);
      const sincePoint = await getSincePointFromReflog(branch);

      const from = sincePoint && sincePoint !== to ? sincePoint : `${remoteBranch}~5`;
      if (sincePoint && sincePoint !== to) {
        console.log(`Changes since last pull (${sincePoint.slice(0, 7)})...`);
      } else {
        console.log('No previous pull found, summarizing last 5 commits...');
      }

      const { primaryFiles, noisyFiles } = await getChangedFiles(from, to);
      let fileSummaries: FileSummary[] = [];

      if (primaryFiles.length > 0) {
        if (config.model.toLowerCase().includes('gemini')) {
            console.log('Using Gemini model: summarizing all files in a single request...');
            const entireDiff = await getGitDiff(from, to, ...primaryFiles);
            if (entireDiff) {
                const combinedSummary = await summarizeEntireDiff(config.model, entireDiff, branch, primaryFiles);
                fileSummaries = parseMultiFileSummary(combinedSummary, primaryFiles);
            }
        } else {
            console.log('Using GPT model: summarizing files individually...');
            for (const file of primaryFiles) {
                const diff = await getGitDiff(from, to, file);
                if (diff) {
                    const summary = await summarizeChanges(config.model, diff, branch, file);
                    fileSummaries.push({ file, summary });
                }
            }
        }
      }
      
      if (fileSummaries.length > 0 || noisyFiles.length > 0) {
        branchSummaries.push({ branch, summaries: fileSummaries, noisyChanges: noisyFiles, from, to });
      } else {
        console.log('No new changes found.');
      }
    }

    if (branchSummaries.length === 0) {
      console.log('\nNo new changes detected on analyzed branches.');
    }
    
    return branchSummaries;
}

async function getSincePointFromReflog(branch: string): Promise<string | null> {
    try {
        const reflog = await git.raw(['reflog', 'show', `origin/${branch}`]);
        const pullLine = reflog.split('\n').find(line => line.includes('pull:'));
        
        if (pullLine) {
            const lines = reflog.split('\n');
            const pullIndex = lines.findIndex(line => line.includes('pull:'));
            if (pullIndex > 0) {
                const prevLine = lines[pullIndex];
                const match = prevLine.match(/^([a-f0-9]+)/);
                if (match) {
                    return match[1];
                }
            }
        }
    } catch (error) {
        // Silently fail
    }
    return null;
}

let server: http.Server | null = null;

program
  .name('codefeed')
  .description('Summarize git changes using AI.')
  .version('1.0.0')
  .action(async () => {
    const startServer = (summaries: BranchSummary[]): Promise<{ server: http.Server, url: string }> => {
        return new Promise(async (resolve) => {
            const port = await portfinder.getPortPromise();
            const html = generateHtml(summaries);
            
            const serverInstance = http.createServer(async (req, res) => {
                if (req.url === '/' && req.method === 'GET') {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(html);
                } else if (req.url === '/lint' && req.method === 'POST') {
                    let body = '';
                    req.on('data', chunk => {
                        body += chunk.toString();
                    });
                    req.on('end', async () => {
                        try {
                            const { file, from, to } = JSON.parse(body);
                            const lintResult = await lintFileWithGpt5(file, from, to);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ summary: lintResult }));
                        } catch (error) {
                            console.error('Linting error:', error);
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Failed to process linting request' }));
                        }
                    });
                } else {
                    res.writeHead(404);
                    res.end();
                }
            });

            serverInstance.listen(port, () => {
                const url = `http://localhost:${port}`;
                resolve({ server: serverInstance, url });
            });
        });
    };

    let keepRunning = true;
    while(keepRunning) {
        try {
            const summaries = await runAnalysis();
            if (summaries.length > 0) {
                const serverInfo = await startServer(summaries);
                server = serverInfo.server;
                console.log(`\nReport is available at: ${serverInfo.url}`);

                const { openBrowser } = await inquirer.prompt([{ 
                    type: 'confirm',
                    name: 'openBrowser',
                    message: 'Open in browser?',
                    default: true
                }]);

                if (openBrowser) {
                    await open(serverInfo.url);
                }
            }
        } catch (error) {
            handleError(error);
        }

        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'What would you like to do next?',
                choices: ['Re-analyze', 'Exit'],
                default: 'Re-analyze',
            },
        ]);

        if (action === 'Exit') {
            keepRunning = false;
        }
        if (server) {
            server.close();
        }
    }
  });

function handleError(error: any) {
    if (axios.isAxiosError(error)) {
        console.error('API Error:', error.response?.data || error.message);
    } else if (error instanceof Error) {
        console.error('Error:', error.message);
    } else {
        console.error('An unknown error occurred.');
    }
}

async function lintFileWithGpt5(file: string, from: string, to: string): Promise<string> {
    console.log(`Requesting GPT-5 lint for ${file}...`);
    const diff = await getGitDiff(from, to, file);
    if (!diff) {
        return "Could not generate diff for linting.";
    }

    const prompt = `
        Please act as an expert code reviewer.
        Analyze the following git diff for the file "${file}".
        Provide a concise code review and style analysis.
        Identify potential bugs, style guide violations, or areas for improvement.
        Use markdown for formatting your response.

        Diff:
        ---
        ${diff}
        ---
    `;
    
    return callGptApi(prompt);
}

async function getDefaultBranch(): Promise<string> {
    const remoteInfo = await git.remote(['show', 'origin']);
    if (remoteInfo) {
        const headBranchMatch = remoteInfo.match(/HEAD branch: (.*)/);
        if (headBranchMatch && headBranchMatch[1]) {
            return headBranchMatch[1];
        }
    }
    const branchSummary = await git.branch();
    return branchSummary.current || 'main';
}

async function getBranchesToAnalyze(): Promise<string[]> {
    const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
    const mainBranch = await getDefaultBranch();
    
    const branches = new Set([mainBranch]);
    if (currentBranch !== mainBranch) {
        branches.add(currentBranch);
    }

    return Array.from(branches);
}

async function getConfiguration(gitRoot: string): Promise<Config> {
  const configPath = path.join(gitRoot, CONFIG_DIR, CONFIG_FILE);

  if (fs.existsSync(configPath)) {
    const configData = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(configData);
  } else {
    return await firstRunSetup(gitRoot);
  }
}

async function firstRunSetup(gitRoot: string): Promise<Config> {
  console.log('First run detected. Setting up codefeed...');

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'model',
      message: 'Which AI model would you like to use by default?',
      choices: ['gpt-5', 'gemini-2.5-pro'],
      default: 'gemini-2.5-pro',
    },
  ]);

  const config: Config = { model: answers.model };
  const configDir = path.join(gitRoot, CONFIG_DIR);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const configPath = path.join(configDir, CONFIG_FILE);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`Configuration saved to ${configPath}`);

  await addToGitignore(gitRoot);

  return config;
}

async function addToGitignore(gitRoot: string) {
  const homeDir = os.homedir();
  const globalGitignorePath = path.join(homeDir, '.gitignore_global');
  if (fs.existsSync(globalGitignorePath)) {
    const globalGitignoreContent = fs.readFileSync(globalGitignorePath, 'utf-8');
    if (globalGitignoreContent.includes('.codefeed')) {
      console.log("'.codefeed' is already ignored in your global .gitignore_global file.");
      return;
    }
  }

  const gitignorePath = path.join(gitRoot, '.gitignore');
  const ignoreEntry = `\n# codefeed configuration\n.codefeed\n`;

  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
    if (!gitignoreContent.includes('.codefeed')) {
      fs.appendFileSync(gitignorePath, ignoreEntry);
      console.log('Added .codefeed to .gitignore');
    }
  } else {
    fs.writeFileSync(gitignorePath, ignoreEntry);
    console.log('Created .gitignore and added .codefeed entry.');
  }
}

async function getChangedFiles(from: string, to: string): Promise<{ primaryFiles: string[], noisyFiles: string[] }> {
    const noisyPatterns = [
        'package-lock.json',
        'yarn.lock',
    ];

    const allChanged = await git.diff([`${from}..${to}`, '--name-only']);
    const allFiles = allChanged.split('\n').filter(file => file.trim() !== '');

    const noisyFiles = allFiles.filter(file => noisyPatterns.some(pattern => file.includes(pattern)));
    const primaryFiles = allFiles.filter(file => !noisyPatterns.some(pattern => file.includes(pattern)));

    return { primaryFiles, noisyFiles };
}


async function getGitDiff(from: string, to: string, ...files: string[]): Promise<string | null> {
  try {
    const diff = await git.diff([`${from}..${to}`, '--', ...files]);
    return diff;
  } catch (e) {
    console.warn(`Could not get diff for ${files.join(', ')}. It's possible the old commit hash is no longer available.`);
    return null;
  }
}

function isContextLengthError(error: any): boolean {
    if (axios.isAxiosError(error)) {
        const errorCode = error.response?.data?.error?.code;
        if (errorCode === 'context_length_exceeded') {
            return true;
        }
        const errorMessage = error.response?.data?.error?.message;
        if (typeof errorMessage === 'string' && errorMessage.includes('token limit')) {
            return true;
        }
    }
    return false;
}

function getTokenLimitForModel(model: string): number {
  const modelLower = model.toLowerCase();
  if (modelLower.includes('gemini')) {
    // Gemini models often have very large context windows
    return 1000000;
  }
  if (modelLower.includes('gpt-5')) {
    // GPT-5 has a smaller context window
    return 8000;
  }
  // A safe, conservative default for unknown models
  return 4000;
}

function estimateTokens(text: string): number {
  // A simple heuristic: 1 token is roughly 4 characters
  return Math.ceil(text.length / 4);
}

function splitDiffIntoChunks(diff: string, maxTokens: number): string[] {
    const chunks: string[] = [];
    const hunks = diff.split(/(?=^@@.*@@$)/m);
    let currentChunk = '';

    for (const hunk of hunks) {
        const hunkTokens = estimateTokens(hunk);
        const currentTokens = estimateTokens(currentChunk);

        if (currentTokens + hunkTokens > maxTokens && currentChunk) {
            chunks.push(currentChunk);
            currentChunk = '';
        }
        currentChunk += hunk;
    }
    if (currentChunk) {
        chunks.push(currentChunk);
    }
    return chunks;
}

async function summarizeEntireDiff(model: string, diff: string, branchName: string, files: string[]): Promise<string> {
    const prompt = `
        Please act as an expert code reviewer.
        Analyze the following git diff for the branch "${branchName}", which includes changes to the following files: ${files.join(', ')}.
        Provide a concise, high-level summary for each file individually.
        Focus on the "why" behind the changes, not just the "what".
        Your response should be a list of summaries, formatted EXACTLY as follows:

        File: path/to/first/file.ts
        Summary: A concise summary of the changes in this file.

        File: path/to/second/file.ts
        Summary: A concise summary of the changes in this file.

        Diff:
        ---
        ${diff}
        ---
    `;
    return callGeminiApi(prompt);
}

function parseMultiFileSummary(summary: string, files: string[]): FileSummary[] {
    const summaries: FileSummary[] = [];
    const lines = summary.split('\n');
    let currentFile: string | null = null;
    let currentSummary = '';

    for (const line of lines) {
        if (line.startsWith('File: ')) {
            if (currentFile && currentSummary) {
                summaries.push({ file: currentFile, summary: currentSummary.trim() });
            }
            currentFile = line.substring('File: '.length).trim();
            currentSummary = '';
        } else if (line.startsWith('Summary: ')) {
            currentSummary += line.substring('Summary: '.length);
        } else if (currentFile) {
            currentSummary += '\n' + line;
        }
    }
    if (currentFile && currentSummary) {
        summaries.push({ file: currentFile, summary: currentSummary.trim() });
    }

    // Ensure all files are accounted for, even if the model missed them
    for (const file of files) {
        if (!summaries.some(s => s.file === file)) {
            summaries.push({ file, summary: "No summary could be generated for this file." });
        }
    }

    return summaries;
}

async function summarizeChanges(model: string, diff: string, branchName: string, fileName: string): Promise<string> {
  const primaryModelFn = model.toLowerCase().startsWith('gpt') ? callGptApi : callGeminiApi;
  const fallbackModelFn = model.toLowerCase().startsWith('gpt') ? callGeminiApi : callGptApi;
  const fallbackModelName = model.toLowerCase().startsWith('gpt') ? 'Gemini' : 'GPT';

  const makeApiCall = async (prompt: string) => {
      try {
          return await primaryModelFn(prompt);
      } catch (error) {
          if (isContextLengthError(error)) {
              console.warn(`Warning: The diff is too long for ${model}. Attempting fallback with ${fallbackModelName}...`);
              return await fallbackModelFn(prompt);
          }
          throw error;
      }
  };

  const tokenLimit = getTokenLimitForModel(model);
  const diffTokens = estimateTokens(diff);

  if (diffTokens < tokenLimit) {
    console.log(`Sending request to ${model} for ${fileName} on ${branchName}...`);
    const prompt = `
      Please provide a concise, high-level summary of the following git diff for the file "${fileName}" on the "${branchName}" branch.
      Focus on the "why" behind the changes, not just the "what".
      Describe the overall impact and purpose of the changes in this file.
      
      Diff:
      ---
      ${diff}
      ---
    `;
    return makeApiCall(prompt);
  } else {
    console.log(`Diff for ${fileName} is too large (${diffTokens} tokens for model ${model}). Starting map-reduce process...`);
    
    // MAP step
    const chunks = splitDiffIntoChunks(diff, tokenLimit - 500); // Leave buffer for prompt
    const chunkSummaries: string[] = [];
    
    for (let i = 0; i < chunks.length; i++) {
        console.log(`Summarizing chunk ${i + 1} of ${chunks.length} for ${fileName}...`);
        const chunkPrompt = `
            This is one chunk of a larger diff for the file "${fileName}". 
            Please provide a concise summary of this specific chunk.
            Focus on the purpose and impact of the changes within this chunk.

            Diff Chunk:
            ---
            ${chunks[i]}
            ---
        `;
        const chunkSummary = await makeApiCall(chunkPrompt);
        chunkSummaries.push(chunkSummary);
    }

    // REDUCE step
    console.log(`Combining ${chunkSummaries.length} chunk summaries for ${fileName}...`);
    const combinedSummaries = chunkSummaries.join('\n\n---\n\n');
    const reducePrompt = `
        The following are several summaries of chunks from a single file's diff ("${fileName}").
        Please synthesize these into a single, coherent, high-level summary.
        Focus on the overall story of the changes, combining the individual points into a cohesive narrative.

        Chunk Summaries:
        ---
        ${combinedSummaries}
        ---
    `;
    
    return makeApiCall(reducePrompt);
  }
}

async function callGptApi(prompt: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is not set.');
    }
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: "gpt-5",
        messages: [{ role: "user", content: prompt }]
    }, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        }
    });
    return response.data.choices[0].message.content.trim();
}

async function callGeminiApi(prompt: string): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable is not set.');
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;
    const response = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }]
    }, {
        headers: {
            'Content-Type': 'application/json'
        }
    });
    return response.data.candidates[0].content.parts[0].text.trim();
}

function generateHtml(summaries: BranchSummary[]): string {
    const summariesHtml = summaries.map(bs => {
        const primarySummaries = bs.summaries.map(fs => `
            <div class="summary-card">
                <h2>${fs.file}</h2>
                <pre>${fs.summary.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
                <div class="actions">
                    <button class="lint-button" data-from="${bs.from}" data-to="${bs.to}" data-file="${fs.file}" data-branch="${bs.branch}">Lint with GPT-5</button>
                </div>
                <div class="lint-result" id="lint-${bs.branch.replace(/[^a-zA-Z0-9]/g, '-')}-${fs.file.replace(/[^a-zA-Z0-9]/g, '-')}"></div>
            </div>
        `).join('');

        const noisySummaries = bs.noisyChanges.length > 0 ? `
            <details class="noisy-details">
                <summary>Other Modified Files</summary>
                <ul>
                    ${bs.noisyChanges.map(file => `<li>${file}</li>`).join('')}
                </ul>
            </details>
        ` : '';

        return `
            <div class="branch-card">
                <h1>Branch: ${bs.branch}</h1>
                ${primarySummaries}
                ${noisySummaries}
            </div>
        `;
    }).join('');

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Codefeed Report</title>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                    background-color: #f0f2f5;
                    color: #1c1e21;
                    margin: 0;
                    padding: 2rem;
                }
                .container {
                    max-width: 800px;
                    margin: 0 auto;
                }
                .branch-card {
                    background-color: #fff;
                    border-radius: 8px;
                    padding: 1.5rem;
                    margin-bottom: 2rem;
                    box-shadow: 0 4px 8px rgba(0,0,0,0.1);
                }
                h1 {
                    color: #1877f2;
                    margin-top: 0;
                }
                .summary-card {
                    background-color: #f9f9f9;
                    border: 1px solid #e4e6eb;
                    border-radius: 6px;
                    padding: 1rem;
                    margin-top: 1rem;
                }
                h2 {
                    color: #1c1e21;
                    border-bottom: 2px solid #e4e6eb;
                    padding-bottom: 0.5rem;
                    margin-top: 0;
                    font-size: 1.2rem;
                }
                pre {
                    white-space: pre-wrap;
                    word-wrap: break-word;
                    background-color: #f5f6f8;
                    padding: 1rem;
                    border-radius: 6px;
                    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
                    font-size: 0.9rem;
                    line-height: 1.5;
                }
                .actions {
                    margin-top: 1rem;
                }
                .lint-button {
                    background-color: #1877f2;
                    color: #fff;
                    border: none;
                    padding: 0.5rem 1rem;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 0.9rem;
                }
                .lint-button:hover {
                    background-color: #166fe5;
                }
                .lint-result {
                    margin-top: 1rem;
                    padding: 1rem;
                    background-color: #e4e6eb;
                    border-radius: 6px;
                    display: none;
                    white-space: pre-wrap;
                    word-wrap: break-word;
                }
                .noisy-details {
                    margin-top: 1rem;
                }
                .noisy-details summary {
                    cursor: pointer;
                    font-weight: bold;
                }
            </style>
        </head>
        <body>
            <div class="container">
                ${summariesHtml}
            </div>
            <script>
                document.addEventListener('DOMContentLoaded', () => {
                    document.querySelectorAll('.lint-button').forEach(button => {
                        button.addEventListener('click', async (event) => {
                            const target = event.target;
                            const file = target.dataset.file;
                            const from = target.dataset.from;
                            const to = target.dataset.to;
                            const branch = target.dataset.branch;
                            const sanitizedBranch = branch.replace(/[^a-zA-Z0-9]/g, '-') ;
                            const sanitizedFile = file.replace(/[^a-zA-Z0-9]/g, '-') ;
                            const resultId = 'lint-' + sanitizedBranch + '-' + sanitizedFile;
                            const resultDiv = document.getElementById(resultId);

                            if (!resultDiv) return;

                            resultDiv.style.display = 'block';
                            resultDiv.textContent = 'Linting in progress...';
                            target.disabled = true;

                            try {
                                const response = await fetch('/lint', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ file, from, to })
                                });

                                if (!response.ok) {
                                    throw new Error('Network response was not ok');
                                }

                                const data = await response.json();
                                resultDiv.innerHTML = data.summary.replace(/</g, "&lt;").replace(/>/g, "&gt;");

                            } catch (error) {
                                console.error('Linting error:', error);
                                resultDiv.textContent = 'An error occurred while linting.';
                            } finally {
                                target.disabled = false;
                            }
                        });
                    });
                });
            </script>
        </body>
        </html>
    `;
}

program.parse(process.argv);
