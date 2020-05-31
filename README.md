# An example of running NestJS on Fargate with App Mesh using AWS CDK (Cloudformation).

App Mesh will route traffic to all three services evenly.

```JSON
{
  "message_url": "http://genericService1.mesh.local:8080",
  "message": {
    "message": "genericService2"
  },
  "metrics": {
    "genericService1": 7,
    "genericService2": 8,
    "genericService3": 6
  }
}
```

## Getting Started

### Building your own generic service
- run `cd ./apps/service`
- run `docker build -t generic-service:3.1`
- run `docker tag generic-service:3.1 192011874229.dkr.ecr.eu-west-1.amazonaws.com/generic-service:3.1`
- run `docker push 192011874229.dkr.ecr.eu-west-1.amazonaws.com/generic-service:3.1`

### Deploying to your account
- run `cd ./cdk`
- Use your own AWS config [here](/cdk/bin/meshdemo.ts)
- run `npm run build`
- run `npm run diff`
- run `npm run deploy`

![alt text](/docs/design.png)