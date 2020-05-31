import {CfnMesh, CfnRoute, CfnVirtualNode, CfnVirtualRouter, CfnVirtualService} from "@aws-cdk/aws-appmesh";
import {Port, SecurityGroup, SubnetType, Vpc} from "@aws-cdk/aws-ec2";
import {Cluster, ContainerImage, FargateService, FargateTaskDefinition, TaskDefinition, LogDriver, Protocol, AppMeshProxyConfiguration} from "@aws-cdk/aws-ecs";
import {CfnTaskDefinition, ContainerDependencyCondition, NetworkMode} from "@aws-cdk/aws-ecs";
import {ApplicationLoadBalancer} from "@aws-cdk/aws-elasticloadbalancingv2";
import {ManagedPolicy, Role, ServicePrincipal} from "@aws-cdk/aws-iam";
import {LogGroup, RetentionDays} from "@aws-cdk/aws-logs";
import {CfnOutput, Construct, Duration, RemovalPolicy, Stack, StackProps} from "@aws-cdk/core";
import {Repository, IRepository} from '@aws-cdk/aws-ecr';

/**
 * Deploys the resources necessary to demonstrate how
 * AWS App Mesh can be used to route traffic to services
 */

export class MeshDemoStack extends Stack {

  // Generic Service App Ports
  readonly appPort = 8080;

  // Generic web services to run
  readonly services = ["genericService1", "genericService2", "genericService3"];

  // service domain / namespace
  readonly namespace: string = "mesh.local";

  // might want to experiment with different ttl during testing
  readonly dnsTtl = Duration.seconds(10);

  stackName: string;
  taskRole: Role;
  taskExecutionRole: Role;
  vpc: Vpc;
  cluster: Cluster;
  internalSecurityGroup: SecurityGroup;
  externalSecurityGroup: SecurityGroup;
  logGroup: LogGroup;
  mesh: CfnMesh;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    /**
     * App Mesh Envoy proxy ECR repository
     */

    const appMeshRepository = Repository.fromRepositoryArn(
      this,
      'app-mesh-envoy',
      'arn:aws:ecr:us-east-1:111345817488:repository/aws-appmesh-envoy'
    );

    /**
     * Generic web service ECR repository
     */

    const genericServiceRepository = Repository.fromRepositoryArn(
      this,
      'generic-service',
      'arn:aws:ecr:eu-west-1:192011874229:repository/generic-service'
    );

    this.createLogGroup();
    this.createVpc();
    this.securityGroups();
    this.createMesh();
    this.createCluster();
    this.createServiceRoles();
    this.createLoadBalancer(genericServiceRepository, appMeshRepository);
    this.createFargateServices(genericServiceRepository, appMeshRepository, ...this.services);
  }

  createLogGroup() {
    /**
     * Create a log group for all services to share
     */
    this.logGroup = new LogGroup(this, "LogGroup", {
      logGroupName: this.stackName,
      retention: RetentionDays.ONE_DAY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  createVpc() {
    /**
     * The VPC will have 2 AZs, 2 NAT gateways, and an internet gateway
     */
    this.vpc = new Vpc(this, "VPC", {
      /**
       * Allocate a block of IPs assignable in this VPC
       */
      cidr: "10.0.0.0/16",
      maxAzs: 2,
      /**
       * Subnets are isolated network partitions used to allow or deny access over the internet
       * - Subnets cannot span multiple availability zones.
       * - One subnet must be created in each availability zones.
       */
      subnetConfiguration: [
        /***
         * Create a public subnet for services publicly accessible over the internet
         * - The subnet will have a routing table associated with a internet gateway.
         * - One subnet is created inside each availability zone.
         * - Necessary to make the application load balancer accessible over the internet.
         */
        {
          // TODO - understand cidrMask and cidr blocks
          name: "ingress",
          subnetType: SubnetType.PUBLIC,
          cidrMask: 24,
        },
        /***
         * Create a private subnet for services which are NOT publicly accessible over the internet
         * - The subnet will have a routing table associated with a NAT gateway
         * - One subnet is created inside each availability zone
         */
        {
          // TODO - understand cidrMask and cidr blocks
          name: "application",
          subnetType: SubnetType.PRIVATE,
          cidrMask: 24,
        },
      ],
    });
  }

  securityGroups() {
    // TODO - Move to each service
    // Allow public inbound web traffic on port 80
    this.externalSecurityGroup = new SecurityGroup(this, "ExternalSG", {
      vpc: this.vpc,
      allowAllOutbound: true,
    });
    this.externalSecurityGroup.connections.allowFromAnyIpv4(Port.tcp(80));

    // Allow communication within the vpc for the app and envoy containers
    // inbound 8080, 9901, 15000; all outbound
    // - 8080: default app port
    // - 9901: envoy admin interface, used for health check
    // - 15000: envoy ingress ports (egress over 15001 will be allowed by allowAllOutbound)
    this.internalSecurityGroup = new SecurityGroup(this, "InternalSG", {
      vpc: this.vpc,
      allowAllOutbound: true,
    });
    [Port.tcp(this.appPort), Port.tcp(9901), Port.tcp(15000)].forEach(port => {
      this.internalSecurityGroup.connections.allowInternally(port);
    });
  }

  createMesh() {
    /**
     * Create service mesh within AWS App Mesh
     */
    this.mesh = new CfnMesh(this, "Mesh", {
      meshName: this.stackName,
    });
    /**
     * Node for each service
     */
    this.createVirtualNodes();
    const router = this.createVirtualRouter();
    this.createRoute(router);
    this.createVirtualService(router);
  }

  createVirtualNodes() {
    /**
     * Define a backend service for the gateway
     */
    const gatewayBackends = [{
      virtualService: {
        virtualServiceName: `${this.services[0]}.${this.namespace}`,
      }
    }]
    this.createSingleVirtualNode("gateway", this.namespace, gatewayBackends);

    /**
     * Here we pick the fist service and assume it's the default one
     * TODO: We can define the services like { url: 'generic-service', services: [A,B,C] }
     */
    // for the first service, creates: {service}-vn => generic-service.mesh.local
    // special case: first service is the default service used for generic-service.mesh.local
    this.createSingleVirtualNode(this.services[0], this.namespace);

    // for all the services except the first one, creates: {service}-vn => generic-service-{service}.mesh.local
    this.services.slice(1).forEach(service => {
      // unfortunately, can't do this until CDK supports creating task with overloaded discovery names
      // create(service, this.namespace, 'generic-service');
      this.createSingleVirtualNode(service, this.namespace);
    });
  }

  createSingleVirtualNode(
    serviceName: string,
    namespace: string,
    backends?: CfnVirtualNode.BackendProperty[]
  ) {
    // name is the task *family* name (eg: "genericService1")
    // namespace is the CloudMap namespace (eg, "mesh.local")
    // serviceName is the discovery name (eg: "generic-service")
    // CloudMap allows discovery names to be overloaded, unfortunately CDK doesn't support yet
      serviceName = serviceName;

      // WARNING: keep name in sync with the route spec, if using this node in a route
      // WARNING: keep name in sync with the virtual service, if using this node as a provider
      // update the route spec as well in createRoute()
      let virtualNodeName = `${serviceName}VirtualNode`;
      (new CfnVirtualNode(this, virtualNodeName, {
        meshName: this.mesh.meshName,
        virtualNodeName: virtualNodeName,
        spec: {
          serviceDiscovery: {
            awsCloudMap: {
              serviceName: serviceName,
              namespaceName: namespace,
              attributes: [
                {
                  key: "ECS_TASK_DEFINITION_FAMILY",
                  value: serviceName,
                },
              ],
            },
          },
          listeners: [{
            portMapping: {
              protocol: "http",
              port: this.appPort,
            },
            healthCheck: {
              healthyThreshold: 2,
              intervalMillis: 10 * 1000,
              path: "/health",
              port: this.appPort,
              protocol: "http",
              timeoutMillis: 5 * 1000,
              unhealthyThreshold: 2,
            },
          }],
          backends: backends,
        },
      })).addDependsOn(this.mesh);
  }

  createVirtualRouter(): CfnVirtualRouter {
    let router = new CfnVirtualRouter(this, "GenericServicesVirtualRouter", {
      virtualRouterName: "genericServiceVirtualRouter",
      meshName: this.mesh.meshName,
      spec: {
        listeners: [{
          portMapping: {
            protocol: "http",
            port: this.appPort,
          },
        }],
      },
    });
    router.addDependsOn(this.mesh);
    return router;
  }

  /**
   * Create routes for the generic virtual service
   */

  createRoute(router: CfnVirtualRouter) {
    let route = new CfnRoute(this, "GenericRoute", {
      routeName: "genericRoute",
      meshName: this.mesh.meshName,
      virtualRouterName: router.virtualRouterName,
      spec: {
        httpRoute: {
          match: {
            prefix: "/",
          },
          action: {
            weightedTargets: this.services.map(service => ({
              virtualNode: `${service}VirtualNode`,
              weight: 1,
            })),
          },
        },
      },
    });
    route.addDependsOn(router);
  }

  /**
   * Create a virtual generic service
   */

  createVirtualService(router: CfnVirtualRouter) {
    let svc = new CfnVirtualService(this, "GenericServiceVirtualService", {
      virtualServiceName: `${this.services[0]}.${this.namespace}`,
      meshName: this.mesh.meshName,
      spec: {
        provider: {
          virtualRouter: {
            virtualRouterName: router.virtualRouterName
          },
        },
      },
    });
    svc.addDependsOn(router);
  }

  createCluster() {
    /**
     * Deploy an ECS cluster
     */
    this.cluster = new Cluster(this, "Cluster", {
      vpc: this.vpc,
    });

    /**
     * Use Cloud Map for service discovery within the cluster, which
     * relies on either ECS Service Discovery or App Mesh integration
     * (default: cloudmap.NamespaceType.DNS_PRIVATE)
     */
    let ns = this.cluster.addDefaultCloudMapNamespace({
      name: this.namespace,
    });

    /**
     * We need to ensure the service record is created for after we enable app mesh
     * (there is no resource we create here that will make this happen implicitly
     * since CDK won't all two services to register the same service name in
     * Cloud Map, even though we can discriminate between them using service attributes
     * based on ECS_TASK_DEFINITION_FAMILY
     * let serviceName = new Service(this, "genericService", {
     *   name: 'genericService',
     *   namespace: ns,
     *   dnsTtl: this.dnsTtl,
     * });
     * serviceName.dependsOn(ns);
     * CDK will print after finished deploying stack
     */
    new CfnOutput(this, "ClusterName", {
      description: "ECS/Fargate cluster name",
      value: this.cluster.clusterName,
    });
  }

  createServiceRoles () {
    // TODO move to the service
    // Grant cloudwatch and xray permissions to IAM task roles useable by all services
    this.taskRole = new Role(this, "TaskRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("CloudWatchLogsFullAccess"),
        ManagedPolicy.fromAwsManagedPolicyName("AWSXRayDaemonWriteAccess"),
        ManagedPolicy.fromAwsManagedPolicyName("AWSAppMeshEnvoyAccess"),
      ],
    });

    // Grant ECR pull permission to IAM task execution role for ECS agent
    this.taskExecutionRole = new Role(this, "TaskExecutionRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ContainerRegistryReadOnly"),
      ],
    });
  }

  createLoadBalancer(genericServiceRepository: IRepository, appMeshRepository: any) {

    const gateway = new FargateAppMeshService(this, {
      serviceName: 'gateway',
      mesh: { meshName: 'mesh' },
      cluster: this.cluster,
      internalSecurityGroup: this.internalSecurityGroup,
      taskRole: this.taskRole,
      taskExecutionRole: this.taskExecutionRole,
      genericServiceRepository: genericServiceRepository,
      logGroup: this.logGroup,
      appMeshRepository,
      appPort: this.appPort,
      dnsTtl: this.dnsTtl,
      environment: {
        SERVER_PORT: `${this.appPort}`,
        MESSAGE_URL: `http://${this.services[0]}.${this.namespace}:${this.appPort}`,
      },
    });

    let alb = new ApplicationLoadBalancer(this, "PublicALB", {
      vpc: this.vpc,
      internetFacing: true,
      securityGroup: this.externalSecurityGroup,
    });
    let albListener = alb.addListener("web", {
      port: 80,
    });
    // Move into service
    // TODO - Service can add itself to the load balancer
    albListener.addTargets("Target", {
      port: 80,
      targets: [gateway.getService()],
      healthCheck: {
        path: "/health",
        port: "traffic-port",
        interval: Duration.seconds(10),
        timeout: Duration.seconds(5),
        healthyHttpCodes: "200-499",
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
      deregistrationDelay: Duration.seconds(1),
    });
    // CDK will print after finished deploying stack
    new CfnOutput(this, "URL", {
      description: "Application Load Balancer public URL",
      value: alb.loadBalancerDnsName,
    });
  }

  createFargateServices(genericServiceRepository: IRepository, appMeshRepository: any, ...services: string[]) {
    /**
     * The first service is a special case; before we enable app mesh, gateway
     * needs to reference an actual genericService1.mesh.local service (MESSAGE_URL);
     * the other services need a unique namespace for now because CDK won't
     * allow reusing the same service name (although we can do this without
     * CDK; this is supported by Cloud Map / App Mesh, which uses Cloud
     * Map attributes for ECS service discovery: ECS_TASK_DEFINITION_FAMILY
     * create(services[0], "genericService");
     */
    new FargateAppMeshService(this, {
      serviceName: services[0],
      mesh: { meshName: 'mesh' },
      cluster: this.cluster,
      internalSecurityGroup: this.internalSecurityGroup,
      taskRole: this.taskRole,
      taskExecutionRole: this.taskExecutionRole,
      genericServiceRepository: genericServiceRepository,
      logGroup: this.logGroup,
      appMeshRepository,
      appPort: this.appPort,
      dnsTtl: this.dnsTtl,
      environment: {
        MESSAGE: services[0],
        // MESSAGE_URL: 'http://generic-service.mesh.local',
      }
    });

    services.slice(1).forEach(service => {
      new FargateAppMeshService(this, {
        serviceName: service,
        mesh: { meshName: 'mesh' },
        cluster: this.cluster,
        internalSecurityGroup: this.internalSecurityGroup,
        taskRole: this.taskRole,
        taskExecutionRole: this.taskExecutionRole,
        genericServiceRepository: genericServiceRepository,
        logGroup: this.logGroup,
        appMeshRepository,
        appPort: this.appPort,
        dnsTtl: this.dnsTtl,
        environment: {
          MESSAGE: service,
          // MESSAGE_URL: 'http://generic-service.mesh.local',
        }
      });
    });
  }
}

interface FargateServiceProps {
  serviceName: string,
  appPort: number,
  taskRole: Role,
  taskExecutionRole: Role,
  genericServiceRepository: IRepository,
  appMeshRepository: IRepository,
  environment: any,
  logGroup: LogGroup,
  cluster: Cluster,
  internalSecurityGroup: SecurityGroup,
  dnsTtl: Duration,
  mesh: {
    meshName: string,
  }
}

class FargateAppMeshService extends Construct {

  constructor(scope: Construct, props: FargateServiceProps) {
    super(scope, props.serviceName);

    let taskDef = new FargateTaskDefinition(this, `${props.serviceName}TaskDefinition`, {
      family: props.serviceName,
      taskRole: props.taskRole,
      executionRole: props.taskExecutionRole,
      cpu: 512,
      memoryLimitMiB: 1024,
      proxyConfiguration: new AppMeshProxyConfiguration({
        containerName: 'envoy',
        properties: {
          appPorts: [props.appPort],
          proxyEgressPort: 15001,
          proxyIngressPort: 15000,
          ignoredUID: 1337,
          egressIgnoredIPs: [
            '169.254.170.2',
            '169.254.169.254'
          ]
        }
      })
    });

    let container = taskDef.addContainer("app", {
      image: ContainerImage.fromEcrRepository(props.genericServiceRepository, '3.1'),
      environment: {
        SERVER_PORT: `${props.appPort}`,
        ...(props || {}).environment,
      },
      logging: LogDriver.awsLogs({
        logGroup: props.logGroup,
        streamPrefix: props.serviceName,
      }),
    });

    container.addPortMappings({
      containerPort: props.appPort,
      hostPort: props.appPort,
    });

    taskDef.addContainer("envoy", {
      image: ContainerImage.fromEcrRepository(props.appMeshRepository, 'v1.11.1.1-prod'),
      user: "1337",
      memoryLimitMiB: 500,
      healthCheck: {
        command: [
          "CMD-SHELL",
          "curl -s http://localhost:9901/server_info | grep state | grep -q LIVE",
        ],
        interval: Duration.seconds(5),
        timeout: Duration.seconds(2),
        startPeriod: Duration.seconds(10),
        retries: 3,
      },
      environment: {
        APPMESH_VIRTUAL_NODE_NAME: `mesh/mesh/virtualNode/${props.serviceName}VirtualNode`,
        ENABLE_ENVOY_XRAY_TRACING: "1",
        ENABLE_ENVOY_STATS_TAGS: "1",
        ENVOY_LOG_LEVEL: "debug",
      },
    });

    let xrayContainer = taskDef.addContainer("xray", {
      image: ContainerImage.fromRegistry("amazon/aws-xray-daemon"),
      user: "1337",
      memoryReservationMiB: 256,
      cpu: 32,
    });

    xrayContainer.addPortMappings({
      containerPort: 2000,
      protocol: Protocol.UDP,
    });

    let service = new FargateService(this, `GenericService-${props.serviceName}`, {
      cluster: props.cluster,
      serviceName: props.serviceName,
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroup: props.internalSecurityGroup,
      cloudMapOptions: {
        // overloading discovery name is possible, but unfortunately CDK doesn't support
        // name: "genericService1",
        name: props.serviceName,
        dnsTtl: props.dnsTtl,
      },
    });

    this.service = service;
  }

  public service: any;

  getService() {
    return this.service;
  }

}