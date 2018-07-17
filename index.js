const pubcontrol = require('pubcontrol')
const grip = require('grip')
const AWS = require('aws-sdk')
const EventEmitter = require('events')
const uuidv4 = require('uuid/v4')

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

var pub = new grip.GripPubControl(gripConfig)

addEventListener('fetch', function (event) {
    event.respondWith(handler(event.request))
})

async function sendMessage(room, msg) {
    var s = 'event: message\n'

    if (msg.id) {
        s += 'id: ' + msg.id + '\n'
    }

    s += 'data: ' + JSON.stringify(msg) + '\n\n'

    var channel
    var id = undefined
    var prevId = undefined
    if (msg.id) {
        channel = 'messages-' + room
        id = '' + msg.id
        prevId = '' + (msg.id - 1)
    } else {
        channel = 'provisional-' + room
    }

    const p = new Promise(resolve => {
        pub.publishHttpStream(
            channel,
            s,
            id,
            prevId,
            function (success, message, context) {
                if (!success) {
                    console.log('Publish failed!');
                    console.log('Message: ' + message);
                    console.log('Context: ');
                    console.dir(context);
                }
                resolve()
            }
        )
    })

    await p
}

function dbAppendMessage(room, msgArg) {
    return new Promise(resolve => {
        var tryWrite = function () {
            console.log('Writing:', msgArg)

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

                //console.log('Read succeeded:', JSON.stringify(data, null, 2))

                var item
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
                    provisionalId: msgArg.provisionalId,
                    from: msgArg.from,
                    text: msgArg.text,
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
                    lastEventId: data.Item.messages[data.Item.messages.length - 1].id
                })
            } else {
                resolve({
                    messages: [],
                    lastEventId: 0
                })
            }
        })
    })
}

async function getFile(fileName) {
    const resp = await fetch('file://client/' + fileName)
    return await resp.text()
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

        const msg = {
            provisionalId: uuidv4(),
            from: mfrom,
            text: text
        }

        // send to clients immediately
        await sendMessage(room, msg)

        // write to DB
        var savedMsg
        try {
            savedMsg = await dbAppendMessage(room, msg)
        } catch (error) {
            console.error(error)

            // send retraction
            msg.retracted = true
            await sendMessage(room, msg)

            const respInit = {
                status: 500,
                headers: {
                    'Content-Type': 'text/plain'
                }
            }

            return new Response('Failed to save message.\n', respInit)
        }

        // send to clients again, officially
        await sendMessage(room, savedMsg)

        const respInit = {
            status: 200,
            headers: {
                'Content-Type': 'application/json'
            }
        }

        return new Response(JSON.stringify(savedMsg) + '\n', respInit)
    } else {
        var gripLastId = null

        const gripLast = request.headers.get('Grip-Last')
        if (gripLast) {
            const pos = gripLast.indexOf('last-id=')
            gripLastId = gripLast.substring(pos + 8)
        }

        if (request.headers.get('Accept') == 'text/event-stream' || gripLastId) {
            const url = new URL(request.url)

            var lastEventId = null

            if (gripLastId) {
                lastEventId = gripLastId
            } else {
                lastEventId = request.headers.get('Last-Event-ID')
                if (!lastEventId) {
                    lastEventId = url.searchParams.get('lastEventId')
                }
            }

            if (lastEventId) {
                lastEventId = parseInt(lastEventId)
                if (isNaN(lastEventId)) {
                    lastEventId = null
                }
            } else {
                lastEventId = null
            }

            const data = await dbGetMessages(room)

            const respInit = {
                status: 200,
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Grip-Hold': 'stream',
                    'Grip-Channel': 'messages-' + room + '; prev-id=' + data.lastEventId + ', provisional-' + room,
                    'Grip-Keep-Alive': 'event: keep-alive\\ndata:\\n\\n; format=cstring; timeout=20',
                    'Grip-Link': '<' + url.pathname + '?recover=true>; rel=next'
                }
            }

            const events = []

            if (!gripLastId) {
                events.push('event: stream-open\n\n')
            }

            if (lastEventId != null && data.messages.length > 0 && lastEventId < data.messages[0].id - 1) {
                events.push('event: stream-reset\n\n')
            }

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
            const res = await fetch('file://client/join.html')
            res.headers.set('content-type', 'text/html')
            return res
        }

        const data = await dbGetMessages(room)

        const templateSrc = await getFile('chat.html')

        var msgsHtml = ''
        for (var i = 0; i < data.messages.length; ++i) {
            const msg = data.messages[i]
            msgsHtml += '<span'
            if (msg.provisionalId) {
                msgsHtml += ' id="' + msg.provisionalId + '"'
            }
            msgsHtml += '><b>' + msg.from + '</b>: ' + msg.text + '</span><br />'
            if (i + 1 < data.messages.length) {
                msgsHtml += '\n        '
            }
        }

        var result = templateSrc
        result = result.replace('{lastEventId}', data.lastEventId)
        result = result.replace('{#messages}', msgsHtml)

        const respInit = {
            status: 200,
            headers: {
                'Content-Type': 'text/html',
                'Cache-Control': 'no-cache'
            }
        }
        return new Response(result, respInit)
    } else if (url.pathname == '/js/eventsource.min.js') {
        const res = await fetch('file://client/eventsource.min.js')
        res.headers.set('content-type', 'application/javascript')
        return res
    } else if (url.pathname == '/js/reconnecting-eventsource.js') {
        const res = await fetch('file://client/reconnecting-eventsource.js')
        res.headers.set('content-type', 'application/javascript')
        return res
    } else if (pathParts.length >= 2 && pathParts[0] == 'rooms') {
        const room = pathParts[1]
        const subpath = pathParts.slice(2).join('/')
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
