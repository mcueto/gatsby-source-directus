const ms = require('ms');
const chalk = require('chalk');
const { Directus } = require('@directus/sdk');
const { sourceNodes, createSchemaCustomization } = require('gatsby-source-graphql/gatsby-node');
const { createRemoteFileNode } = require('gatsby-source-filesystem');

/**
 * Validate plugin options
 */
exports.pluginOptionsSchema = ({ Joi }) => {
	return Joi.object().keys({
		url: Joi.string().required(),
		auth: Joi.object()
			.keys({
				token: Joi.string(),
				email: Joi.string(),
				password: Joi.string(),
			})
			.with('email', 'password')
			.with('password', 'email')
			.xor('token', 'email'),
		type: Joi.object()
			.keys({
				name: Joi.string(),
				field: Joi.string(),
			})
			.optional(),
		dev: Joi.object().keys({
			refresh: [Joi.number(), Joi.string()],
		}),
		graphql: Joi.object(),
	});
};

/**
 * Gatsby source implementation.
 */

exports.sourceNodes = async (gatsbyOptions, pluginOptions) => {
	const { actions: { createNode }, createNodeId, store, cache, reporter } = gatsbyOptions
	const { headers } = await plugin.getOptions();
	const { Authorization } = await headers();

	await plugin.setOptions(pluginOptions);

	const optionsSystem = plugin.getOptionsSystem();
	const options = plugin.getOptions();

	// Avoid type conflict with gatsby-source-graphql
	gatsbyOptions.actions.createNode = (node) => {
		if (node.internal.type === 'GraphQLSource') {
			if (node.typeName === optionsSystem.typeName) node.internal.type = 'DirectusSystemGraphQLSource';
			if (node.typeName === options.typeName) node.internal.type = 'DirectusGraphQLSource';
		}

		return createNode(node);
	};

	await sourceNodes(gatsbyOptions, optionsSystem);
	await sourceNodes(gatsbyOptions, options);

	// Load images here rather than on file resolution.
	// Create a node for each image and store it in the cache
	// so it can bre retrieved on file resolution.
	const remoteImages = await plugin.getAllImages();
	remoteImages.forEach(async (image) => {
		const cachedImage = await cache.get(image.id)
		if (cachedImage !== undefined) {
			return
		}
		const nameParts = image.filename_download.split('.');
		const ext = nameParts.length > 1 ? `.${nameParts.pop()}` : '';
		const name = nameParts.join('.');
		const imageUrl = `${plugin.url}assets/${image.id}`;
		const img = await createRemoteFileNode({
			url: imageUrl,
			parentNodeId: image.id,
			store,
			cache,
			createNode,
			createNodeId,
			httpHeaders: { Authorization },
			reporter,
			ext,
			name,
		});
		await cache.set(image.id, img);
	})
};

exports.createSchemaCustomization = async (gatsby, pluginOptions) => {
	await plugin.setOptions(pluginOptions);

	await createSchemaCustomization(gatsby, plugin.getOptionsSystem());
	await createSchemaCustomization(gatsby, plugin.getOptions());
};

/**
 * Gatsby file implementation.
 */
exports.createResolvers = async ({ cache, createResolvers }, pluginOptions) => {
	await plugin.setOptions(pluginOptions);

	const fileResolver = {
		imageFile: {
			type: `File`,
			async resolve(source) {
				// Lookup the cached image node and return it
				const cachedFile = await cache.get(source.id);
				return cachedFile;
			},
		},
	};

	await createResolvers({
		DirectusData_directus_files: fileResolver,
		DirectusSystemData_directus_files: fileResolver,
	});
};

class Plugin {
	constructor() {
		// eslint-disable-next-line no-undef
		this.fileCache = new Map();
		this.directus = null;
		this.options = null;
		this.urlGraphqlSystem = '';
		this.urlGraphql = '';
		this.url = '';
		this.refreshInterval = 0;
		this.authPromise = null;
	}

	async setOptions(options) {
		const { url, dev, auth } = options;

		if (isEmpty(url)) error('"url" must be defined');

		if (this.directus) return this.authPromise;

		const hasAuth = !!auth;
		const hasToken = !isEmpty(auth?.token);
		const hasEmail = !isEmpty(auth?.email);
		const hasPassword = !isEmpty(auth?.password);
		const hasCredentials = hasEmail && hasPassword;

		if (hasAuth) {
			if (!hasToken && !hasCredentials) error('"auth.token" or ("auth.email" and "auth.password") must be defined');
		} else warning('no "auth" option were defined. Resources will be fetched with public role');

		try {
			const baseUrl = new URL(url);
			const basePath = baseUrl.pathname.endsWith('/') ? baseUrl.pathname.slice(0, -1) : baseUrl.pathname;
			
			baseUrl.pathname = basePath;
			this.url = baseUrl.toString();

			baseUrl.pathname = basePath + '/graphql';
			this.urlGraphql = baseUrl.toString();

			baseUrl.pathname = basePath + '/graphql/system';
			this.urlGraphqlSystem = baseUrl.toString();
		} catch (err) {
			error('"url" should be a valid URL');
		}

		try {
			this.directus = new Directus(this.url);

			if (hasToken) this.authPromise = await this.directus.auth.static(auth.token);

			if (hasCredentials)
				this.authPromise = await this.directus.auth.login({ email: auth?.email, password: auth?.password });
		} catch (err) {
			error(`authentication failed with: ${err.message}\nAre credentials valid?`);
		}

		this.refreshInterval = typeof dev?.refresh === 'string' ? ms(dev.refresh) / 1000 : dev?.refresh || 15;

		if (Number.isNaN(this.refreshInterval))
			error('"dev.refresh" should be a number in seconds or a string with ms format, i.e. 5s, 5m, 5h, ...');

		this.options = options;

		return this.authPromise;
	}

	getOptions() {
		const internalOptions = ['url', 'dev', 'auth', 'type'];
		const gatsbyPluginOptions = Object.fromEntries(
			Object.entries(this.options).flatMap(([key, value]) => (internalOptions.includes(key) ? [] : [[key, value]]))
		);

		return {
			...this.options.graphql,
			...gatsbyPluginOptions,
			url: this.urlGraphql,
			typeName: this.options?.type?.name || 'DirectusData',
			fieldName: this.options?.type?.field || 'directus',
			headers: this.headers.bind(this),
		};
	}

	getOptionsSystem() {
		const options = this.getOptions();

		return {
			...options,
			url: this.urlGraphqlSystem,
			typeName: this.options?.type?.system_name || 'DirectusSystemData',
			fieldName: this.options?.type?.system_field || 'directus_system',
		};
	}

	/**
	 * Method to retrieve all of the images in directus.files
	 */
	async getAllImages() {
		const files = await this.directus.files.readByQuery({ limit: -1 });
		const imageFiles = files.data.filter(file => file.type.indexOf('image') > -1);
		return imageFiles;
	}

	async headers() {
		let headers = {};
		if (typeof this.options?.headers === 'object') {
			Object.assign(headers, this.options.headers || {});
		} else if (typeof this.options?.headers === 'function') {
			Object.assign(headers, (await this.options.headers()) || {});
		}

		if (this.directus.auth.token) {
			Object.assign(headers, {
				Authorization: `Bearer ${this.directus.auth.token}`,
			});
		}

		return headers;
	}
}

class Log {
	static log(level, message) {
		let color = level === 'error' ? 'red' : level === 'warning' ? 'yellow' : 'white';

		// eslint-disable-next-line no-console
		console.log(chalk.cyan('gatsby-source-directus'), ':', chalk[color](message));
	}
	static error(message) {
		Log.log('error', message);
	}
	static warning(message) {
		Log.log('error', message);
	}
}

function isEmpty(value) {
	if (value?.constructor === String) return value.length === 0;

	return true;
}

function error(message) {
	Log.error(message);

	const error = new Error(`gatsby-source-directus: ${message}`);
	error.stack = undefined;

	throw error;
}

function warning(message) {
	Log.warning(message);
}

const plugin = new Plugin();
