import { jiraIssueKeyParser } from "utils/jira-utils";
import { JiraRemoteLinkBulkSubmitData, JiraRemoteLinkStatusAppearance } from "interfaces/jira";
import { GitHubInstallationClient } from "../github/client/github-installation-client";
import Logger from "bunyan";
import { createInstallationClient } from "../util/get-github-client-config";
import { WebhookContext } from "../routes/github/webhook/webhook-context";
import { transformRepositoryId } from "~/src/transforms/transform-repository-id";

const MAX_STRING_LENGTH = 255;

const getPullRequestTitle = async (repoName: string, prId: number, repoOwner: string, githubClient: GitHubInstallationClient, logger: Logger): Promise<string> => {

	const response = await githubClient.getPullRequest(repoOwner, repoName, prId);

	if (response.status !== 200) {
		logger.warn({ response }, "Received error when querying for Pull Request information.");
		return "";
	} else {
		return response.data.title;
	}
};

const getEntityTitle = async (ref: string, repoName: string, repoOwner: string, githubClient: GitHubInstallationClient, logger: Logger): Promise<string> => {
	// ref can either be a branch reference or a PR reference
	const components = ref.split("/");
	switch (components[1]) {
		case "heads": // branch
			// The branch name may contain forward slashes! Rejoin them
			return Promise.resolve(components.slice(2).join("/"));
		case "pull": // pull request
			return await getPullRequestTitle(repoName, parseInt(components[2]), repoOwner, githubClient, logger);
		default:
			logger.error(`Could not interpret reference from code_scanning_alert: ${ref}`);
			return "";
	}
};

// Status can be one of three things from the code_scanning_alert webhook: open, fixed, or dismissed
const transformStatusToAppearance = (status: string, context: WebhookContext): JiraRemoteLinkStatusAppearance => {
	switch (status) {
		case "open":
			return "removed"; // red
		case "fixed":
			return "success"; // green
		case "dismissed":
			return "moved"; // yellow
		default:
			context.log.info(`Received unknown status from code_scanning_alert webhook: ${status}`);
			return "default";
	}
};

export const transformCodeScanningAlert = async (context: WebhookContext, githubInstallationId: number, jiraHost: string): Promise<JiraRemoteLinkBulkSubmitData | undefined> => {
	const { action, alert, ref, repository } = context.payload;

	const gitHubInstallationClient = await createInstallationClient(githubInstallationId, jiraHost, context.log, context.gitHubAppConfig?.gitHubAppId);

	// Grab branch names or PR titles
	const entityTitles: string[] = [];
	if (action === "closed_by_user" || action === "reopened_by_user") {
		if (!alert.instances?.length) {
			return undefined;
		}
		// These are manual operations done by users and are not associated to a specific Issue.
		// The webhook contains ALL instances of this alert, so we need to grab the ref from each instance.
		entityTitles.push(...await Promise.all(alert.instances.map(
			(instance) => getEntityTitle(instance.ref, repository.name, repository.owner.login, gitHubInstallationClient, context.log))
		));
	} else {
		// The action is associated with a single branch/PR
		entityTitles.push(await getEntityTitle(ref, repository.name, repository.owner.login, gitHubInstallationClient, context.log));
	}

	const issueKeys = entityTitles.flatMap((entityTitle) => jiraIssueKeyParser(entityTitle) ?? []);
	if (!issueKeys.length) {
		return undefined;
	}

	return {
		remoteLinks: [{
			schemaVersion: "1.0",
			id: `${transformRepositoryId(repository.id, gitHubInstallationClient.baseUrl)}-${alert.number}`,
			updateSequenceNumber: Date.now(),
			displayName: `Alert #${alert.number}`,
			description: alert.rule.description.substring(0, MAX_STRING_LENGTH) || undefined,
			url: alert.html_url,
			type: "security",
			status: {
				appearance: transformStatusToAppearance(alert.most_recent_instance.state, context),
				label: alert.most_recent_instance.state
			},
			lastUpdated: alert.updated_at || alert.created_at,
			associations: [{
				associationType: "issueKeys",
				values: issueKeys
			}]
		}]
	};
};
