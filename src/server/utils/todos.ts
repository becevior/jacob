import { getExtractedIssue } from "~/server/api/utils";
import { getIssue } from "~/server/github/issue";
import { db } from "~/server/db/db";
import { TodoStatus } from "~/server/db/enums";
import { researchIssue } from "~/server/agent/research";
import { cloneRepo } from "~/server/git/clone";
import { getSourceMap } from "~/server/analyze/sourceMap";
import { getOrGeneratePlan } from "./plan";
import { getRepoSettings } from "./settings";

const agentRepos = (process.env.AGENT_REPOS ?? "").split(",") ?? [];

export const createTodo = async (
  repo: string,
  projectId: number,
  issueNumber: number,
  accessToken: string | undefined,
) => {
  const [repoOwner, repoName] = repo?.split("/") ?? [];

  if (!repoOwner || !repoName) {
    throw new Error("Invalid repo name");
  }

  if (!accessToken) {
    throw new Error("Access token is required");
  }

  // Check if a todo for this issue already exists
  const existingTodo = await db.todos.findByOptional({
    projectId: projectId,
    issueId: issueNumber,
  });

  if (existingTodo) {
    console.log(`Todo for issue #${issueNumber} already exists`);
    return;
  }

  // Fetch the specific issue
  const { data: issue } = await getIssue(
    { name: repoName, owner: { login: repoOwner } },
    accessToken,
    issueNumber,
  );

  const issueBody = issue.body ? `\n${issue.body}` : "";
  const issueText = `${issue.title}${issueBody}`;

  let cleanupClone: (() => Promise<void>) | undefined;
  try {
    const { path: rootPath, cleanup } = await cloneRepo({
      repoName: repo,
      token: accessToken,
    });
    cleanupClone = cleanup;

    const repoSettings = await getRepoSettings(rootPath, repo);
    const sourceMap = getSourceMap(rootPath, repoSettings);
    const extractedIssue = await getExtractedIssue(sourceMap, issueText);

    const newTodo = await db.todos.create({
      projectId: projectId,
      description: `${issue.title}\n\n${issueBody}`,
      name: extractedIssue.commitTitle ?? issue.title ?? "New Todo",
      status: TodoStatus.TODO,
      issueId: issue.number,
      position: issue.number,
    });

    // Only research issues and create plans for agent repos for now
    // TODO: only research issues for premium accounts
    if (agentRepos.includes(repo?.trim())) {
      await researchIssue({
        githubIssue: issueText,
        todoId: newTodo.id,
        issueId: issue.number,
        rootDir: rootPath,
        projectId,
      });
      await getOrGeneratePlan({
        projectId,
        issueId: issue.number,
        githubIssue: issueText,
        rootPath,
      });
    } else {
      console.log(
        `Skipping research for repo ${repo} issue #${issue.number}. Agent repos are ${agentRepos.join(
          ", ",
        )}`,
      );
    }

    console.log(`Created new todo for issue #${issue.number}`);
    return newTodo;
  } catch (error) {
    console.error(
      `Error while creating todo for issue #${issue.number}: ${String(error)}`,
    );
    // Consider more specific error handling here
  } finally {
    if (cleanupClone) {
      await cleanupClone();
    }
  }
};
