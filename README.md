# Fly Chat

This chat demo shows how to build a serverless realtime application with [Fanout Cloud](https://fanout.io/) and [Fly](https://fly.io/). The backend is a JavaScript application that runs statelessly on Fly. Streaming connections are handled by Fanout Cloud. Message data is stored in AWS DynamoDB.

There is a public instance: http://flychat.fanoutapp.com/

## How it works

Fanout Cloud works as a proxy server in front of the Fly app. Clients make requests to Fanout Cloud, which are then forwarded to the Fly app. For the streaming endpoint, the Fly app controls Fanout Cloud using the [GRIP protocol](https://pushpin.org/docs/protocols/grip). For all other endpoints, the Fly app sends normal HTTP responses and Fanout Cloud acts as a passthrough.

The [client/server API](#api) is simple and clean: mainly a GET to receive a Server-Sent Events stream of messages for a chatroom, and a POST to send a message to a chatroom.

This project highlights several important technical achievements:

* Statelessness - One usually thinks of realtime web applications as being quite stateful, due to the need for long-lived connections. By delegating long-lived connection management to Fanout Cloud, it is possible to write business logic that can be executed statelessly by Fly, resulting in a realtime serverless architecture. There are no long-running processes to manage. The Fly app can be modified and redeployed at any time without disconnecting clients.

* Custom API - The client/server API has no Fly-isms or Fanout-isms to it. Everything about the API, including the paths, data formats, and the domain name, are defined by the code in this project and any Fly and Fanout service configurations associated with an instance. Fanout Cloud doesn't even have direct awareness of SSE; instead, it offers a powerful HTTP streaming primitive that supports sending arbitrary bytes. SSE protocol logic actually happens in the Fly app.

* Reliable delivery - The SSE stream uses `Last-Event-ID` for recovery after disconnections. Further, the project makes use of Fanout Cloud's reliability mechanism on the backend side. If the Fly app fails to publish messages to Fanout Cloud for any reason (e.g. the app crashes), the stream will eventually be repaired such that the client always sees a perfect SSE stream without any gaps.

The app also does a couple of tricks:

* Server-side rendering - For snappy loading, the chat history is pre-rendered into the initial HTML received by the browser.

* Provisional sending - Messages are published to Fanout Cloud before writing to DynamoDB. This ensures other clients receive each message as soon as possible (via Fanout and Fly regional datacenters), without having to wait on a round trip to a centralized DB.

## Running locally

[Pushpin](https://pushpin.org/) can be used in place of Fanout Cloud to run the application locally. More on that later.

First, install dependencies:

```sh
npm install
```

Create a `.fly.yml` file:

```yaml
config:
  gripUrl:
    fromSecret: gripUrl
  awsDbKeyId:
    fromSecret: awsDbKeyId
  awsDbSecretKey:
    fromSecret: awsDbSecretKey
  awsDbRegion: us-east-1
  awsDbTable: flychat-messages

files:
  - client/eventsource.min.js
  - client/reconnecting-eventsource.js
  - client/join.html
  - client/chat.html
```

The config in `.fly.yml` refers to secrets that must be placed in a `.fly.secrets.yml`:

```yaml
gripUrl: http://localhost:5561
awsDbKeyId: {aws-key-id}
awsDbSecretKey: {aws-secret-key}
```

The AWS credentials are needed to access DynamoDB.

Run the `create-table.js` program to create the necessary DynamoDB tables:

```sh
node create-table.js
```

Run Fly locally:

```sh
fly server
```

Ensure Pushpin is running with the following route:

```
* localhost:3000
```

Then open a browser to Pushpin's server port (e.g. 7999) and you should see the chat app.

## Deploying

Create a Fly app:

```sh
fly apps create {your-app-name}
```

Be sure the app name is also set in your `.fly.yml` as the `app` value.

Decide on a Fanout realm to use. In the Fanout control panel, note the realm's ID and key. Also, decide whether to use a built-in domain (i.e. `{realm-id}.fanoutcdn.com`) or a custom domain. In either case, edit the domain's Origin Server to point to `{your-app-name}.edgeapp.net:80`. This way, requests made to your Fanout domain will be proxied to your Fly app.

Add the Fanout domain as a valid hostname for the Fly app:

```
fly hostnames add {your-fanout-domain}
```

Set secrets:

```sh
fly secrets set gripUrl "https://api.fanout.io/realm/{realm-id}?iss={realm-id}&key=base64:{realm-key}"
fly secrets set awsDbKeyId {aws-key-id}
fly secrets set awsDbSecretKey {aws-secret-key}
```

Deploy the code:

```sh
fly deploy
```

Then open a browser to your Fanout domain and you should see the chat app.

## API

### Get messages:

```http
GET /rooms/{room-id}/messages/
Accept: text/event-stream
```

Params:

* `Last-Event-ID` (header): ID of most recent event received by client (if any).
* `lastEventId`: same as `Last-Event-ID` but with less precedence. Use to construct an SSE URL that starts from a certain ID.

Returns: SSE events, defined below.

* `message`: JSON message, with fields: `from`, `text`, `date`.
* `stream-open`: Sent when connection is first opened, in order to flush "on connected" callbacks in some SSE clients.
* `stream-reset`: Sent if the server is unable to provide messages expected by the client. This can happen if messages the client doesn't have yet are removed before it has a chance to receive them (e.g. because the client machine was suspended for a long time). This state is unrecoverable. The user must refresh the browser and start clean.

### Send message:

```http
POST /rooms/{room-id}/messages/
```

Params:

* `from={string}`: the name of the user sending the message.
* `text={string}`: the content of the message.

Returns: JSON object of message.
