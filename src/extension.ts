import { Octokit } from "@octokit/rest";
import * as vscode from "vscode";
import { setPAT } from "./auth/pat";
import { getClient } from "./client/client";
import { initConfiguration } from "./configuration/configuration";
import { Protocol } from "./external/protocol";
import { getGitHubProtocol, getGitHubUrl } from "./git/repository";
import { LogScheme } from "./logs/constants";
import { WorkflowStepLogProvider } from "./logs/fileProvider";
import { WorkflowStepLogFoldingProvider } from "./logs/foldingProvider";
import { updateDecorations } from "./logs/formatProvider";
import { getLogInfo } from "./logs/logInfoProvider";
import { buildLogURI } from "./logs/scheme";
import { WorkflowStepLogSymbolProvider } from "./logs/symbolProvider";
import {
  Secret,
  Workflow,
  WorkflowJob,
  WorkflowRun,
  WorkflowStep,
} from "./model";
import { initPinnedWorkflows } from "./pinnedWorkflows/pinnedWorkflows";
import { encodeSecret } from "./secrets";
import { initWorkflowDocumentTracking } from "./tracker/workflowDocumentTracker";
import { initResources } from "./treeViews/icons";
import { SettingsTreeProvider } from "./treeViews/settings";
import { ActionsExplorerProvider as WorkflowsTreeProvider } from "./treeViews/workflows";
import { BaseReactPanel } from "./webviews/baseReactPanel";
import { WorkflowPreview } from "./webviews/workflowPreview";
import {
  getRepositoryDispatchTypes,
  getWorkflowUri,
} from "./workflow/workflow";

export function activate(context: vscode.ExtensionContext) {
  // Prefetch git repository origin url
  getGitHubUrl();

  initResources(context);

  initConfiguration(context);
  initPinnedWorkflows(context);

  // Track workflow documents
  initWorkflowDocumentTracking(context);

  // Actions Explorer
  const workflowTreeProvider = new WorkflowsTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("workflows", workflowTreeProvider)
  );

  const settingsTreeProvider = new SettingsTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("settings", settingsTreeProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("explorer.refresh", () => {
      workflowTreeProvider.refresh();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("explorer.openRun", (args) => {
      const url = args.url || args;
      vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(url));
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "explorer.openWorkflowFile",
      async (args) => {
        const wf: Workflow = args.wf;

        const fileUri = getWorkflowUri(wf.path);
        if (fileUri) {
          const textDocument = await vscode.workspace.openTextDocument(fileUri);
          vscode.window.showTextDocument(textDocument);
          return;
        }

        // File not found in workspace
        vscode.window.showErrorMessage(
          `Workflow ${wf.path} not found in current workspace`
        );
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("explorer.triggerRun", async (args) => {
      let event_type: string | undefined;

      let workflowUri: vscode.Uri | null = null;

      const wf: Workflow = args.wf;
      if (wf) {
        workflowUri = getWorkflowUri(wf.path);
      } else if (args.fsPath) {
        workflowUri = args;
      }

      if (!workflowUri) {
        return;
      }

      const event_types = getRepositoryDispatchTypes(workflowUri.fsPath);
      if (event_types?.length > 0) {
        const custom_type = "✐ Enter custom type";
        const selection = await vscode.window.showQuickPick(
          [custom_type, ...event_types],
          {
            placeHolder: "Select an event_type to dispatch",
          }
        );

        if (selection === undefined) {
          return;
        } else if (selection !== custom_type) {
          event_type = selection;
        }
      }

      if (event_type === undefined) {
        event_type = await vscode.window.showInputBox({
          prompt: "Enter `event_type` to dispatch to the repository",
          value: "default",
        });
      }

      if (event_type) {
        const repo: Protocol = args.repo || (await getGitHubProtocol());
        const client: Octokit = args.client || (await getClient());

        await client.repos.createDispatchEvent({
          owner: repo.owner,
          repo: repo.repositoryName,
          event_type,
          client_payload: {},
        });

        vscode.window.setStatusBarMessage(
          `GitHub Actions: Repository event '${event_type}' dispatched`,
          2000
        );

        workflowTreeProvider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("auth.login", async () => {
      const selection = "Enter PAT";
      switch (selection) {
        case "Enter PAT":
          const token = await vscode.window.showInputBox({
            prompt: "Enter a GitHub PAT with `workflow` and `repo` scope:",
          });
          if (token) {
            await setPAT(token);
            workflowTreeProvider.refresh();
          }
          break;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workflow.run.open", async (args) => {
      const run: WorkflowRun = args.run;
      const url = run.html_url;
      vscode.env.openExternal(vscode.Uri.parse(url));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workflow.logs", async (args) => {
      const repo: Protocol = args.repo;
      const job: WorkflowJob = args.job;
      const step: WorkflowStep | undefined = args.step;
      const uri = buildLogURI(
        repo.owner,
        repo.repositoryName,
        job.id,
        step?.name
      );
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
      });

      const logInfo = getLogInfo(uri);
      if (!logInfo) {
        throw new Error("Could not get log info");
      }

      // Custom formatting after the editor has been opened
      updateDecorations(editor, logInfo);

      // Deep linking
      if (step) {
        let matchingSection = logInfo.sections.find(
          (s) => s.name && s.name === step.name
        );
        if (!matchingSection) {
          // If we cannot match by name, see if we can try to match by number
          matchingSection = logInfo.sections[step.number - 1];
        }

        if (matchingSection) {
          editor.revealRange(
            new vscode.Range(
              matchingSection.start,
              0,
              matchingSection.start,
              0
            ),
            vscode.TextEditorRevealType.InCenter
          );
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workflow.run.rerun", async (args) => {
      const repo: Protocol = args.repo;
      const run: WorkflowRun = args.run;
      const client: Octokit = args.client;

      try {
        await client.actions.reRunWorkflow({
          owner: repo.owner,
          repo: repo.repositoryName,
          run_id: run.id,
        });
      } catch (e) {
        vscode.window.showErrorMessage(
          `Could not rerun workflow: '${e.message}'`
        );
      }

      workflowTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workflow.run.cancel", async (args) => {
      const repo: Protocol = args.repo;
      const run: WorkflowRun = args.run;
      const client: Octokit = args.client;

      try {
        await client.actions.cancelWorkflowRun({
          owner: repo.owner,
          repo: repo.repositoryName,
          run_id: run.id,
        });
      } catch (e) {
        vscode.window.showErrorMessage(
          `Could not cancel workflow: '${e.message}'`
        );
      }

      workflowTreeProvider.refresh();
    })
  );

  //
  // Settings
  //
  context.subscriptions.push(
    vscode.commands.registerCommand("settings.secret.add", async (args) => {
      const repo: Protocol = args.repo;
      const client: Octokit = args.client;

      const name = await vscode.window.showInputBox({
        prompt: "Enter name for new secret",
      });

      if (!name) {
        return;
      }

      const value = await vscode.window.showInputBox({
        prompt: "Enter the new secret value",
      });

      if (value) {
        try {
          const keyResponse = await client.actions.getPublicKey({
            owner: repo.owner,
            repo: repo.repositoryName,
          });

          const key_id = keyResponse.data.key_id;
          const key = keyResponse.data.key;

          await client.actions.createOrUpdateSecretForRepo({
            owner: repo.owner,
            repo: repo.repositoryName,
            name: name,
            key_id: key_id,
            encrypted_value: encodeSecret(key, value),
          });
        } catch (e) {
          vscode.window.showErrorMessage(e.message);
        }
      }

      settingsTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("settings.secret.delete", async (args) => {
      const repo: Protocol = args.repo;
      const secret: Secret = args.secret;
      const client: Octokit = args.client;

      await client.actions.deleteSecretFromRepo({
        owner: repo.owner,
        repo: repo.repositoryName,
        name: secret.name,
      });

      settingsTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("settings.secret.update", async (args) => {
      const repo: Protocol = args.repo;
      const secret: Secret = args.secret;
      const client: Octokit = args.client;

      const value = await vscode.window.showInputBox({
        prompt: "Enter the new secret value",
      });

      if (value) {
        try {
          const keyResponse = await client.actions.getPublicKey({
            owner: repo.owner,
            repo: repo.repositoryName,
          });

          const key_id = keyResponse.data.key_id;
          const key = keyResponse.data.key;

          await client.actions.createOrUpdateSecretForRepo({
            owner: repo.owner,
            repo: repo.repositoryName,
            name: secret.name,
            key_id: key_id,
            encrypted_value: encodeSecret(key, value),
          });
        } catch (e) {
          vscode.window.showErrorMessage(e.message);
        }
      }
    })
  );

  //
  // Log providers
  //
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      LogScheme,
      new WorkflowStepLogProvider()
    )
  );

  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider(
      { scheme: LogScheme },
      new WorkflowStepLogFoldingProvider()
    )
  );

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      {
        scheme: LogScheme,
      },
      new WorkflowStepLogSymbolProvider()
    )
  );

  //
  // Editor support
  //
  context.subscriptions.push(
    vscode.commands.registerCommand("workflow.edit.preview", () => {
      BaseReactPanel.createOrShow(WorkflowPreview, context.extensionPath);

      vscode.workspace.onDidChangeTextDocument((changeEvent) => {
        // Check for active preview
        // TODO: Refactor
        if (
          BaseReactPanel.currentPanel &&
          BaseReactPanel.currentPanel instanceof WorkflowPreview
        ) {
          BaseReactPanel.currentPanel.update(changeEvent.document.getText());
        }
      });
    })
  );
}

// this method is called when your extension is deactivated
export function deactivate() {}
