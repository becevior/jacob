import { db } from "~/server/db/db";
import { env } from "~/env";
import {
  EvaluationMode,
  IssueBoardSource,
  type JiraIssue,
  type JiraAccessibleResource,
  type JiraBoard,
} from "~/types";
import { type IssueBoard } from "~/server/db/tables/issueBoards.table";
import { refreshGitHubAccessToken } from "../github/tokens";
import { createGitHubIssue, rewriteGitHubIssue } from "../github/issue";

export async function refreshJiraAccessToken(
  accountId: number,
): Promise<string> {
  const account = await db.accounts.find(accountId);
  if (!account?.jiraRefreshToken) {
    throw new Error("No refresh token available");
  }

  const response = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: env.JIRA_CLIENT_ID,
      client_secret: env.JIRA_CLIENT_SECRET,
      refresh_token: account.jiraRefreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to refresh Jira access token");
  }

  const data = await response.json();
  await db.accounts.find(accountId).update({
    jiraAccessToken: data.access_token,
    jiraRefreshToken: data.refresh_token,
  });

  return data.access_token;
}

export async function fetchJiraProjects(accessToken: string, cloudId: string) {
  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/project/search`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    const errorDetails = await response.text();
    console.error("Error details:", errorDetails);
    throw new Error(`Failed to fetch Jira projects: ${response.statusText}`);
  }

  const data = await response.json();
  return data.values as JiraBoard[];
}

export async function syncJiraBoard(
  jiraAccessToken: string,
  cloudId: string,
  projectId: number,
  boardId: string,
  userId: number,
  githubAccessToken: string,
) {
  console.log(`Syncing Jira board ${boardId} for project ${projectId}`);
  const boardResponse = await fetch(
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/project/${boardId}`,
    {
      headers: {
        Authorization: `Bearer ${jiraAccessToken}`,
        Accept: "application/json",
      },
    },
  );

  if (!boardResponse.ok) {
    const errorDetails = await boardResponse.text();
    console.error("Error details:", errorDetails);
    throw new Error(
      `Failed to fetch Jira board details: ${boardResponse.statusText}`,
    );
  }

  const boardData: JiraBoard = await boardResponse.json();

  // first check if the board already exists
  const existingBoard = await db.issueBoards.findByOptional({
    projectId,
    issueSource: IssueBoardSource.JIRA,
    originalBoardId: boardId,
  });

  if (!existingBoard) {
    const project = await db.projects.findBy({ id: projectId });
    if (!project) {
      throw new Error("Project not found");
    }

    await db.issueBoards.create({
      issueSource: IssueBoardSource.JIRA,
      projectId,
      originalBoardId: boardId,
      repoFullName: project.repoFullName,
      boardUrl: boardData.self,
      boardName: boardData.name,
      createdBy: userId,
    });
  }

  await fetchNewJiraIssues({
    jiraAccessToken,
    cloudId,
    projectId,
    boardId,
    userId,
    githubAccessToken,
  });
  console.log(`Successfully synced Jira board ${boardId}`);

  return { success: true };
}

export async function fetchAllNewJiraIssues() {
  let issueBoards: IssueBoard[] = [];
  try {
    issueBoards = await db.issueBoards.where({
      issueSource: IssueBoardSource.JIRA,
    });
  } catch (error: any) {
    console.error(`Error fetching issue boards: ${error.message}`);
    return;
  }

  for (const issueBoard of issueBoards) {
    try {
      // get the user from the issue board
      const account = await db.accounts.findBy({
        userId: issueBoard.createdBy,
      });
      if (!account?.jiraAccessToken) {
        throw new Error("User not found");
      }

      const project = await db.projects.findBy({ id: issueBoard.projectId });
      if (!project?.jiraCloudId) {
        throw new Error("Project not found");
      }
      // check to see if the account's token is expired
      // account.expires_at is a unix timestamp in seconds
      let githubAccessToken: string | undefined = account.access_token;
      if (
        account.expires_at &&
        Date.now() > (account.expires_at as unknown as number) * 1000
      ) {
        githubAccessToken = await refreshGitHubAccessToken(account.userId);
      }
      if (!githubAccessToken) {
        throw new Error("Failed to refresh GitHub access token");
      }
      await fetchNewJiraIssues({
        jiraAccessToken: account.jiraAccessToken,
        cloudId: project.jiraCloudId,
        projectId: issueBoard.projectId,
        boardId: issueBoard.originalBoardId,
        userId: account.userId,
        githubAccessToken,
      });
    } catch (error) {
      console.error(
        `Error fetching Jira issues for board ${issueBoard.id}:`,
        error,
      );
    }
  }
}

export async function fetchNewJiraIssues({
  jiraAccessToken,
  cloudId,
  projectId,
  boardId,
  userId,
  githubAccessToken,
  numAttempts = 0,
}: {
  jiraAccessToken: string;
  cloudId: string;
  projectId: number;
  boardId: string;
  userId: number;
  githubAccessToken: string;
  numAttempts?: number;
}) {
  if (numAttempts > 3) {
    throw new Error("Failed to fetch Jira issues");
  }
  const issueBoard = await db.issueBoards.findBy({
    projectId,
    issueSource: IssueBoardSource.JIRA,
    originalBoardId: boardId,
  });

  const project = await db.projects.findBy({ id: projectId });

  try {
    const jql = `project=${boardId} AND created>=-2h`; // note that the cron job runs every hour
    const fields = "id,self,summary,description";

    const response = await fetch(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(fields)}`,
      {
        headers: {
          Authorization: `Bearer ${jiraAccessToken}`,
          Accept: "application/json",
        },
      },
    );

    if (response.status === 401) {
      console.log("Jira access token expired, refreshing...");
      // get the user from the issue board
      jiraAccessToken = await refreshJiraAccessToken(userId);
      return fetchNewJiraIssues({
        jiraAccessToken,
        cloudId,
        projectId,
        boardId,
        userId,
        githubAccessToken,
        numAttempts: numAttempts + 1,
      });
    }
    if (!response.ok) {
      const errorDetails = await response.text();
      console.error("Error details:", errorDetails);
      throw new Error(`Failed to fetch Jira issues: ${response.statusText}`);
    }
    type OriginalJiraIssue = {
      id: string;
      fields: {
        summary: string;
        description: any;
      };
      self: string;
    };

    const data = await response.json();
    const issues: JiraIssue[] = data.issues.map((issue: OriginalJiraIssue) => ({
      id: issue.id,
      url: issue.self,
      number: parseInt(issue.id),
      title: issue.fields.summary,
      description: extractTextFromADF(issue.fields.description),
    }));
    for (const issue of issues) {
      // first check if the issue already exists
      const existingIssue = await db.issues.findByOptional({
        issueBoardId: issueBoard.id,
        issueId: issue.id,
      });

      if (existingIssue) {
        console.log(
          `Repo ${project.repoFullName}: Jira issue ${issue.id} already exists`,
        );
        continue;
      }

      console.log(
        `Repo ${project.repoFullName}: Creating new Jira issue ${issue.id}`,
      );
      // create a new issue in the database - this ensures we don't duplicate issues
      await db.issues.create({
        issueBoardId: issueBoard.id,
        issueId: issue.id,
        title: issue.title,
      });
      const owner = project.repoFullName.split("/")[0];
      const repo = project.repoFullName.split("/")[1];
      if (!owner || !repo) {
        throw new Error("Invalid repo full name");
      }
      // use AI to generate a more detailed github issue description
      const githubIssueDescription = await rewriteGitHubIssue(
        githubAccessToken,
        owner,
        repo,
        issue.title,
        issue.description,
        EvaluationMode.DETAILED,
      );
      const githubIssueBody = githubIssueDescription.rewrittenIssue;
      // create a new GitHub issue - there is a listener for this in the queue that will create a todo
      const githubIssue = await createGitHubIssue(
        owner,
        repo,
        issue.title,
        githubIssueBody,
        githubAccessToken,
      );

      console.log(
        `Repo ${project.repoFullName}: Created GitHub issue ${githubIssue.data.number} for Jira issue ${issue.id}`,
      );
    }
  } catch (error) {
    console.error(`Error fetching Jira issues for board ${boardId}:`, error);
  }
}

export async function getJiraCloudIdResources(accessToken: string) {
  // Fetch accessible resources to obtain cloudId
  const resourcesResponse = await fetch(
    "https://api.atlassian.com/oauth/token/accessible-resources",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );

  if (!resourcesResponse.ok) {
    throw new Error("Failed to fetch accessible resources");
  }

  const resourcesData: JiraAccessibleResource[] =
    await resourcesResponse.json();

  if (resourcesData.length === 0) {
    throw new Error("No accessible resources found");
  }
  return resourcesData;
}

// https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
// Jira issues are stored in ADF format, need to extract the text from it
export function extractTextFromADF(adfNode: any): string {
  let text = "";

  if (Array.isArray(adfNode)) {
    for (const node of adfNode) {
      text += extractTextFromADF(node);
    }
  } else if (adfNode && typeof adfNode === "object") {
    if (adfNode.type === "text" && typeof adfNode.text === "string") {
      text += adfNode.text;
    } else if (adfNode.content) {
      text += extractTextFromADF(adfNode.content);
    }
  }

  return text;
}
