const jwt = require('jwt-simple')
const grip = require('grip')

const gripConfig = grip.parseGripUri(app.config.gripUrl)

console.log(JSON.stringify(gripConfig))

addEventListener('fetch', function (event) {
    event.respondWith(handler(event.request))
})

async function sendEvent(room, data) {
    const s = 'event: message\ndata: ' + JSON.stringify(data) + '\n\n'

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

    await fetch(gripConfig.control_uri + '/publish/', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({items: [item]})
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

        const data = {
            'from': mfrom,
            'text': text
        }

        await sendEvent(room, data)

        const respInit = {
            status: 200,
            headers: {
                'Content-Type': 'application/json'
            }
        }

        return new Response(JSON.stringify(data) + '\n', respInit)
    } else {
        if (request.headers.get('Accept') == 'text/event-stream') {
            const respInit = {
                status: 200,
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Grip-Hold': 'stream',
                    'Grip-Channel': 'messages-' + room
                }
            }

            return new Response('event: stream-open\n\n', respInit)
        } else {
            const respInit = {
                status: 200,
                headers: {
                    'Content-Type': 'application/json'
                }
            }
            return new Response('[]\n', respInit)
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
