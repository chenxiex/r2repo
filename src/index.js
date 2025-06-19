/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
const BLACK_LIST = []

function authorizeRequest(request, env, key) {
	switch (request.method) {
		case "GET":
			return BLACK_LIST.includes(key) ? false : true;
		default:
			return false;
	}
}

// 判断是否为目录
function isDirectoryPath(path) {
	return path === '' || path.endsWith('/');
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		let key = url.pathname.slice(1);

		// 检查是否为API请求
		const isApiRequest = url.pathname.startsWith('/api/');

		// 如果是API请求，移除前缀
		if (isApiRequest) {
			key = key.replace(/^api\//, '');
		}

		if (!authorizeRequest(request, env, key)) {
			return new Response("Forbidden", { status: 403 });
		}

		switch (request.method) {
			case 'GET':
				// 判断是目录请求还是文件请求
				if (isDirectoryPath(key)) {
					if (!isApiRequest) {
						const indexHtml = await env.ASSETS.fetch(request);
						if (indexHtml === null) {
							return new Response("index.html not found", { status: 404 });
						}

						return new Response(indexHtml.body, {
							headers: {
								'Content-Type': 'text/html; charset=utf-8',
							},
						});
					}
					// API请求时返回JSON数据
					// 处理目录请求
					const prefix = key;
					const options = {
						prefix: prefix,
						delimiter: '/',
					};

					const listing = await env.REPO_BUCKET.list(options);
					const objects = listing.objects.filter(obj => !BLACK_LIST.includes(obj.key));
					const directories = listing.delimitedPrefixes
						.filter(prefix => !BLACK_LIST.includes(prefix))
						.map(prefix => ({
							key: prefix,
							name: prefix.split('/').slice(-2)[0] || prefix,
							isDirectory: true
						}));

					// 组合目录和文件列表
					const items = [
						...directories,
						...objects.map(obj => ({
							key: obj.key,
							name: obj.key.split('/').pop() || obj.key,
							size: obj.size,
							uploaded: obj.uploaded,
							isDirectory: false
						}))
					];

					return new Response(JSON.stringify({
						path: '/' + key,
						items: items,
						parent: key === '' ? null : '/' + key.split('/').slice(0, -2).join('/') + '/'
					}), {
						headers: {
							'Content-Type': 'application/json',
							'Access-Control-Allow-Origin': '*'
						},
					});
				} else {
					// 处理文件请求
					const object = await env.REPO_BUCKET.get(key);

					if (object === null) {
						return new Response("Object Not Found", { status: 404 });
					}

					const headers = new Headers();
					object.writeHttpMetadata(headers);
					headers.set("etag", object.httpEtag);

					// 设置Content-Disposition头使浏览器默认下载文件
					const filename = key.split('/').pop();
					headers.set("Content-Disposition", `inline; filename="${filename}"`);

					return new Response(object.body, {
						headers,
					});
				}
			default:
				return new Response("Method Not Allowed", {
					status: 405,
					headers: {
						Allow: "GET",
					},
				});
		}
	},
};
