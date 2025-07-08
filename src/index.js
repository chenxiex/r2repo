/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

// 判断是否为目录
function isDirectoryPath(path) {
	return path === '' || path.endsWith('/');
}

async function preListCheck(env) {
	const { success } = await env.BUCKET_A_RATE_LIMITER.limit({ key: 'A' })
	if (!success) {
		return new Response("Too Many Requests", { status: 429 });
	}
}

async function preGetCheck(env) {
	const { success } = await env.BUCKET_B_RATE_LIMITER.limit({ key: 'B' })
	if (!success) {
		return new Response("Too Many Requests", { status: 429 });
	}
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		let key = url.pathname.slice(1);

		// 检查是否为API请求
		const isApiRequest = url.searchParams.has('api')

		switch (request.method) {
			case 'GET':
				// 判断是目录请求还是文件请求
				if (isDirectoryPath(key)) {

					const prefix = key;
					const options = {
						prefix: prefix,
						delimiter: '/',
						limit: 500,
					};

					const listCheckResp = await preListCheck(env);
					if (listCheckResp) {
						return listCheckResp;
					}
					const listing = await env.REPO_BUCKET.list(options);
					const objects = listing.objects;
					let delimitedPrefixes = new Set(listing.delimitedPrefixes);

					// 如果目录路径不存在，返回404
					if (objects.length === 0 && delimitedPrefixes.size === 0) {
						return new Response("Not Found", { status: 404 });
					}

					// 如果不是API请求，返回HTML页面
					if (!isApiRequest) {
						const indexHtml = await env.ASSETS.fetch(new URL('/index.html', 'https://assets.local'));
						if (indexHtml === null) {
							return new Response("Not found", { status: 404 });
						}

						return new Response(indexHtml.body, {
							headers: {
								'Content-Type': 'text/html; charset=utf-8',
							},
						});
					}

					let truncated = listing.truncated;
					let cursor = truncated ? listing.cursor : undefined;

					while (truncated) {
						const listCheckResp = await preListCheck(env);
						if (listCheckResp) {
							return listCheckResp;
						}
						const next = await env.REPO_BUCKET.list({
							...options,
							cursor: cursor,
						});
						objects.push(...next.objects);
						next.delimitedPrefixes.forEach(prefix => delimitedPrefixes.add(prefix));

						truncated = next.truncated;
						cursor = next.cursor;
					}

					// API请求时返回JSON数据
					const directories = Array.from(delimitedPrefixes)
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
						parent: key === '' ? null : (
							key.split('/').filter(Boolean).length <= 1
								? '/'
								: '/' + key.split('/').slice(0, -2).join('/') + '/'
						)
					}), {
						headers: {
							'Content-Type': 'application/json',
							'Access-Control-Allow-Origin': '*'
						},
					});
				} else {
					// 处理文件请求
					const getCheckResp = await preGetCheck(env);
					if (getCheckResp) {
						return getCheckResp;
					}

					// 首先获取文件的元数据来确定文件大小
					const objectHead = await env.REPO_BUCKET.head(key);
					if (objectHead === null) {
						return new Response("Not Found", { status: 404 });
					}

					const fileSize = objectHead.size;
					const rangeHeader = request.headers.get('range');
					
					let object;
					let start = 0;
					let end = fileSize - 1;
					let isRangeRequest = false;

					// 处理 Range 请求
					if (rangeHeader) {
						const rangeMatch = rangeHeader.match(/bytes=(\d*)-(\d*)/);
						if (rangeMatch) {
							isRangeRequest = true;
							const rangeStart = rangeMatch[1] ? parseInt(rangeMatch[1]) : 0;
							const rangeEnd = rangeMatch[2] ? parseInt(rangeMatch[2]) : fileSize - 1;
							
							// 验证范围的有效性
							if (rangeStart >= fileSize || rangeEnd >= fileSize || rangeStart > rangeEnd) {
								return new Response("Requested Range Not Satisfiable", { 
									status: 416,
									headers: {
										'Content-Range': `bytes */${fileSize}`
									}
								});
							}
							
							start = rangeStart;
							end = rangeEnd;
							
							// 使用 range 参数获取指定范围的数据
							object = await env.REPO_BUCKET.get(key, {
								range: { offset: start, length: end - start + 1 }
							});
						} else {
							// 无效的 Range 格式，返回完整文件
							object = await env.REPO_BUCKET.get(key);
						}
					} else {
						// 没有 Range 请求，返回完整文件
						object = await env.REPO_BUCKET.get(key);
					}

					if (object === null) {
						return new Response("Not Found", { status: 404 });
					}

					const headers = new Headers();
					object.writeHttpMetadata(headers);
					headers.set("etag", objectHead.httpEtag);
					headers.set("accept-ranges", "bytes");

					if (isRangeRequest) {
						// 设置 206 状态码和相关头部
						headers.set("content-range", `bytes ${start}-${end}/${fileSize}`);
						headers.set("content-length", (end - start + 1).toString());
						
						return new Response(object.body, {
							status: 206,
							headers,
						});
					} else {
						// 完整文件响应
						headers.set("content-length", fileSize.toString());
						
						return new Response(object.body, {
							headers,
						});
					}
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
