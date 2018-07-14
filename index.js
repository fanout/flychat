const jwt = require('jwt-simple')
const grip = require('grip')
const AWS = require('aws-sdk')
const EventEmitter = require('events')

const MAX_MESSAGES = 50

AWS.HttpClient.prototype.handleRequest = function handleRequest(httpRequest, httpOptions, callback, errCallback) {
  var self = this;
  var endpoint = httpRequest.endpoint;
  var emitter = new EventEmitter();

  callback(emitter);

  var href = endpoint.protocol + '//' + endpoint.hostname;
  if (endpoint.port !== 80 && endpoint.port !== 443) {
    href += ':' + endpoint.port;
  }
  href += httpRequest.path;

  const body = httpRequest.body && typeof httpRequest.body.buffer === 'object' ?
    httpRequest.body.buffer :
    httpRequest.body

  const req = new Request(href, { method: httpRequest.method, body: body })

  AWS.util.each(httpRequest.headers, function (key, value) {
    if (key !== 'Content-Length' && key !== 'User-Agent' && key !== 'Host') {
      req.headers.set(key, value);
    }
  });

  // console.log("sending req: ", httpRequest.method, href)
  // console.log("req headers: ", JSON.stringify(req.headers.toJSON()))

  fetch(req).then((res) => {
    // console.log("GOT RES", res.status, JSON.stringify(res.headers.toJSON()))
    res.arrayBuffer().then((buf) => {
      // console.log("GOT BUF", buf.byteLength)
      const headers = {};
      for (const k of Object.keys(res.headers.toJSON())) {
        headers[k] = res.headers.getAll(k).join(",");
      }
      emitter.statusCode = res.status
      emitter.headers = headers
      emitter.emit("headers", emitter.statusCode, emitter.headers, res.statusText);
      emitter.emit("data", buf)
      emitter.emit("end")
    }).catch((err) => {
      // console.log("error getting array buffer", err)
      emitter.emit("end")
    })
  }).catch((err) => {
    errCallback(AWS.util.error(new Error('Network Failure'), {
      code: 'NetworkingError'
    }));
  })

  return emitter;
}

AWS.config.update({
    accessKeyId: app.config.awsDbKeyId,
    secretAccessKey: app.config.awsDbSecretKey,
    region: app.config.awsDbRegion
})

const db = new AWS.DynamoDB.DocumentClient()

const gripConfig = grip.parseGripUri(app.config.gripUrl)

addEventListener('fetch', function (event) {
    event.respondWith(handler(event.request))
})

async function sendEvent(room, data) {
    const s = 'event: message\nid: ' + data.id + '\ndata: ' + JSON.stringify(data) + '\n\n'

    const item = {
        channel: 'messages-' + room,
        formats: {
            'http-stream': {
                content: s
            }
        }
    }

    const headers = {
        'Content-Type': 'application/json'
    }

    if (gripConfig.control_iss) {
        const claim = {
            iss: gripConfig.control_iss,
            exp: Math.floor(new Date().getTime() / 1000) + 600
        }

        const token = jwt.encode(claim, gripConfig.key)

        headers['Authorization'] = 'Bearer ' + token
    }

    try {
        await fetch(gripConfig.control_uri + '/publish/', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({items: [item]})
        })
    } catch (error) {
        console.error(error)
    }
}

function dbAppendMessage(room, mfrom, text) {
    return new Promise(resolve => {
        var tryWrite = function () {
            console.log('Writing:', {from: mfrom, text: text})

            var params = {
                TableName: app.config.awsDbTable,
                Key: {
                    room: room
                },
                ConsistentRead: true
            }

            db.get(params, function (err, data) {
                if (err) {
                    console.error('Read failed:', JSON.stringify(err, null, 2))
                    resolve({})
                    return
                }

                //console.log("Read succeeded:", JSON.stringify(data, null, 2))

                var item;
                if (data.Item) {
                    item = data.Item
                } else {
                    item = {
                        room: room,
                        version: 0,
                        messages: []
                    }
                }

                const prevVersion = item.version

                item.version = prevVersion + 1

                const msg = {
                    id: item.version,
                    from: mfrom,
                    text: text,
                    date: new Date().toISOString()
                }

                item.messages.push(msg)

                var trim = 0
                if (item.messages.length > MAX_MESSAGES) {
                    trim = item.messages.length - MAX_MESSAGES
                }

                item.messages = item.messages.slice(trim)

                const expected = {}
                if (prevVersion > 0) {
                    expected.version = {
                        Value: prevVersion
                    }
                } else {
                    expected.room = {
                        Exists: false
                    }
                }

                params = {
                    TableName: app.config.awsDbTable,
                    Expected: expected,
                    Item: item
                }

                db.put(params, function (err, data) {
                    if (err) {
                        console.error('Write failed:', JSON.stringify(err, null, 2))

                        if (err.code == 'ConditionalCheckFailedException') {
                            tryWrite()
                            return
                        }

                        resolve({})
                        return
                    }

                    console.log('Write succeeded:', msg)

                    resolve(msg)
                })
            })
        }

        tryWrite()
    })
}

function dbGetMessages(room) {
    return new Promise(resolve => {
        const params = {
            TableName: app.config.awsDbTable,
            Key: {
                room: room
            },
            ConsistentRead: true
        }

        db.get(params, function (err, data) {
            if (err) {
                console.error('Read failed:', JSON.stringify(err, null, 2))
                resolve({})
                return
            }

            if (data.Item) {
                resolve({
                    messages: data.Item.messages,
                    'last-event-id': data.Item.messages[data.Item.messages.length - 1].id
                })
            } else {
                resolve({
                    messages: [],
                    'last-event-id': 0
                })
            }
        })
    })
}

async function messages(request, room) {
    if (request.method == 'POST') {
        const params = await request.formData()

        const mfrom = params.get('from')
        const text = params.get('text')

        if (!mfrom || !text) {
            const respInit = {
                status: 400,
                headers: {
                    'Content-Type': 'text/plain'
                }
            }
            return new Response('Bad Request\n', respInit)
        }

        const data = await dbAppendMessage(room, mfrom, text)

        if (data) {
            await sendEvent(room, data)

            const respInit = {
                status: 200,
                headers: {
                    'Content-Type': 'application/json'
                }
            }

            return new Response(JSON.stringify(data) + '\n', respInit)
        } else {
            const respInit = {
                status: 500,
                headers: {
                    'Content-Type': 'text/plain'
                }
            }

            return new Response('Failed to save message.\n', respInit)
        }
    } else {
        if (request.headers.get('Accept') == 'text/event-stream') {
            var lastEventId = request.headers.get('Last-Event-ID')
            if (!lastEventId) {
                const url = new URL(request.url)
                lastEventId = url.searchParams.get('lastEventId')
            }

            if (lastEventId) {
                lastEventId = parseInt(lastEventId)
                if (isNaN(lastEventId)) {
                    lastEventId = null
                }
            } else {
                lastEventId = null
            }

            const respInit = {
                status: 200,
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Grip-Hold': 'stream',
                    'Grip-Channel': 'messages-' + room,
                    'Grip-Keep-Alive': 'event: keep-alive\\ndata:\\n\\n; format=cstring; timeout=20'
                }
            }

            const data = await dbGetMessages(room)

            const events = []
            events.push('event: stream-open\n\n')

            for (var i = 0; i < data.messages.length; ++i) {
                const msg = data.messages[i]
                if (lastEventId != null && msg.id <= lastEventId) {
                    continue
                }

                events.push('event: message\nid: ' + msg.id + '\ndata: ' + JSON.stringify(msg) + '\n\n')
            }

            return new Response(events.join(''), respInit)
        } else {
            const data = await dbGetMessages(room)

            const respInit = {
                status: 200,
                headers: {
                    'Content-Type': 'application/json'
                }
            }
            return new Response(JSON.stringify(data) + '\n', respInit)
        }
    }
}

async function handler(request) {
    const url = new URL(request.url)

    const pathParts = url.pathname.substring(1).split('/')

    if (pathParts.length == 1) {
        if (pathParts[0] == '') {
            const respInit = {
                status: 301,
                headers: {
                    'Location': '/default' + url.search
                }
            }
            return new Response('', respInit)
        }

        const room = pathParts[0]
        const user = url.searchParams.get('user')

        if (!user) {
            const res = await fetch("file://client/join.html")
            res.headers.set("content-type", "text/html")
            return res
        }

        const res = await fetch("file://client/chat.html")
        res.headers.set("content-type", "text/html")
        return res
    } else if (url.pathname == '/js/eventsource.min.js') {
        const res = await fetch("file://client/eventsource.min.js")
        res.headers.set("content-type", "application/javascript")
        return res
    } else if (url.pathname == '/js/reconnecting-eventsource.js') {
        const res = await fetch("file://client/reconnecting-eventsource.js")
        res.headers.set("content-type", "application/javascript")
        return res
    } else if (pathParts.length >= 2 && pathParts[0] == 'rooms') {
        const room = pathParts[1]
        const subpath = pathParts.slice(2).join('/');
        if (subpath == 'messages/') {
            return await messages(request, room);
        } else {
            const respInit = {
                status: 404,
                headers: {
                    'Content-Type': 'text/plain'
                }
            }
            return new Response('Not Found\n', respInit)
        }
    } else {
        const respInit = {
            status: 404,
            headers: {
                'Content-Type': 'text/plain'
            }
        }
        return new Response('Not Found\n', respInit)
    }
}
