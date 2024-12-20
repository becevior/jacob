import { type NextRequest, NextResponse } from "next/server";
import { env } from "~/env";
import { db } from "~/server/db/db";
import { getServerAuthSession } from "~/server/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      return NextResponse.json(
        { error: "Missing code or state" },
        { status: 400 },
      );
    }
    console.log("state", state);

    const projectIdString = state?.split("-")[2];
    const projectId = parseInt(projectIdString ?? "");
    console.log("projectId", projectId);
    console.log("code", code);
    const body = {
      grant_type: "authorization_code",
      client_id: env.LINEAR_CLIENT_ID,
      client_secret: env.LINEAR_CLIENT_SECRET,
      code: code,
      redirect_uri: `${env.NEXTAUTH_URL}/api/auth/linear/callback`,
    };
    console.log("body", body);

    const tokenResponse = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    });

    if (!tokenResponse.ok) {
      throw new Error("Failed to exchange code for token");
    }

    const tokenData = await tokenResponse.json();
    console.log("tokenData", tokenData);
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;

    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "User not authenticated" },
        { status: 401 },
      );
    }

    const userId = parseInt(session.user.id);
    console.log("userId", userId);

    await db.accounts.where({ userId }).update({
      linearAccessToken: accessToken,
      linearRefreshToken: refreshToken,
    });

    const project = await db.projects.find(projectId);
    console.log("project", project);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    return NextResponse.redirect(
      `${env.NEXTAUTH_URL}/dashboard/${project.repoFullName}/settings`,
    );
  } catch (error) {
    console.error("Error in Linear OAuth callback:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
