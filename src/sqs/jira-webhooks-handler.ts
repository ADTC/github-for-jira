import { MessageHandler, SQSMessageContext, WebhookMessagePayload } from "./sqs.types";
import { getConfiguredAppProperties, saveConfiguredAppProperties } from "utils/app-properties-utils";
import { Installation } from "models/installation";
import { statsd } from "config/statsd";
import { metricHttpRequest } from "config/metric-names";
import { Subscription } from "models/subscription";
import { getJiraClient } from "~/src/jira/client/jira-client";

export const jiraWebhooksQueueMessageHandler: MessageHandler<WebhookMessagePayload> = async (context: SQSMessageContext<WebhookMessagePayload>) => {
	const { payload } = context;
	context.log.debug({ payload }, "Handling jira webhook from the SQS queue");

	try {
		const event = payload?.path?.event;
		switch (event) {
			case "installed":
				await jiraInstallWebhook(context);
				break;
			case "enabled":
				await jiraEnabledWebhook(context);
				break;
			case "disabled":
				// do nothing
				break;
			case "uninstalled":
				await jiraUninstalledWebhook(context);
				break;
			default:
				context.log.warn({ payload }, `Unknown event of type '${event}'`);
				break;
		}
	} catch (err) {
		context.log.error(err, "Cannot process Jira webhook because of error");
	}
};

const jiraInstallWebhook = async (context: SQSMessageContext<WebhookMessagePayload>) => {
	context.log.info("Received installation payload");

	const { body: { baseUrl, clientKey, sharedSecret } } = context.payload;
	await Installation.install({
		host: baseUrl,
		clientKey,
		sharedSecret
	});

	context.log.info("Installed installation");

	statsd.increment(metricHttpRequest.install);
};

const jiraEnabledWebhook = async (context: SQSMessageContext<WebhookMessagePayload>) => {
	const { body: { baseUrl } } = context.payload;
	try {
		const appProperties = await getConfiguredAppProperties(baseUrl, undefined, undefined, context.log);
		if (!appProperties || appProperties.status !== 200) {
			await saveConfiguredAppProperties(baseUrl, undefined, undefined, context.log, false);
			context.log.info("App property set to false after installation for ", baseUrl);
		}
	} catch (err) {
		context.log.error({ err }, "Failed to set app property after installation");
	}
};

const jiraUninstalledWebhook = async (context: SQSMessageContext<WebhookMessagePayload>) => {
	const { body: { clientKey } } = context.payload;

	if (!clientKey) {
		context.log.debug("Missing clientKey for webhook");
		return;
	}

	const installation = await Installation.getForClientKey(clientKey);
	if (!installation) {
		context.log.debug("Missing installation for webhook");
		return;
	}

	const { jiraHost } = installation;

	context.log = context.log.child({
		jiraHost,
		jiraClientKey: `${clientKey.substr(0, 5)}***}`
	});
	const subscriptions = await Subscription.getAllForHost(installation.jiraHost);

	if (subscriptions) {
		await Promise.all(subscriptions.map((sub) => sub.uninstall()));
	}

	statsd.increment(metricHttpRequest.uninstall);

	const jiraClient = await getJiraClient(installation.jiraHost, undefined, undefined, context.log);

	// Don't wait for promise as it might fail if the property is not set
	jiraClient.appProperties.delete();
	await installation.uninstall();

	context.log.info("App uninstalled on Jira.");
};

