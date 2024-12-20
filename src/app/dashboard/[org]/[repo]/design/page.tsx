import { redirect } from "next/navigation";
import { getServerAuthSession } from "~/server/auth";
import Design from "./Design";
import { Suspense } from "react";
import { getDashboardUsers } from "~/app/utils";

const dashboardUsers = getDashboardUsers();

const DesignPage = async ({
  params,
}: {
  params: { org: string; repo: string };
}) => {
  const { user } = (await getServerAuthSession()) ?? {};
  if (!user?.login || !dashboardUsers.includes(user.login.toLowerCase())) {
    redirect("/");
  }

  const { org, repo } = params;
  return (
    <Suspense>
      <Design org={org} repo={repo} />
    </Suspense>
  );
};

export default DesignPage;
