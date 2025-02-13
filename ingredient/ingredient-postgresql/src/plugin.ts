/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseIngredient, IngredientManager,IIngredient,DeploymentContext } from "@azbake/core"
import { ARMHelper } from "@azbake/arm-helper"
import { PostgreSQLDBUtils } from "./functions"
import { VnetData } from "./vnetData"
import PublicAccessARMTemplate from "./PublicAccessArm.json" 
import PrivateAccessARMTemplate from "./PrivateAccessArm.json"
import { Subnet,VirtualNetwork } from "@azure/arm-network/esm/models"

export class PostgreSQLDB extends BaseIngredient {

    constructor(name: string, ingredient: IIngredient, ctx: DeploymentContext) {
        super(name, ingredient, ctx);
        this._helper = new ARMHelper(this._ctx);
        this._functions = new PostgreSQLDBUtils(this._ctx);

    }

    _helper: ARMHelper;
    _functions: PostgreSQLDBUtils; 
    private _access: string | undefined;
    private _armTemplate: any;

    public async Execute(): Promise<void> {
        let params: any;
        try {
            params = await this._helper.BakeParamsToARMParamsAsync(this._name, this._ingredient.properties.parameters)
            this._access = params.access.value.toLowerCase();
            if (this._access == "public") {
                this._armTemplate = PublicAccessARMTemplate
            } else if (this._access == "private") {
                this._armTemplate = PrivateAccessARMTemplate;
            } else throw new Error("Parameter 'access' must be set to \"public\" or \"private\".");

            this.validateBakeParams(params);
        } 
        catch (error){
            this._logger.error('Bake validation failed: ' + error)
            throw error;
        }

        if (this._access == "private")
        {
            params.vnetData = await this.getVnetData(params);

            // Microsoft.Resources/deployments reuse deployment names because they aren't cleaned up.
            params.virtualNetworkDeploymentName = {value: `virtualNetwork_${params.serverName}`};
            params.virtualNetworkLinkDeploymentName = {value: `virtualNetworkLink_${params.serverName}`};
            params.privateDnsZoneDeploymentName = {value: `privateDnsZone_${params.serverName}`};
            
            // Hard coding this for security
            params.publicNetworkAccess = {value: 'Disabled'};
        }

        if (!params.firewallRules)
        {
            params.firewallRules = {value: {rules: [] }};
        }

        this.trimParametersForARM(params);

        try {
            const util = IngredientManager.getIngredientFunction("coreutils", this._ctx);
            this._logger.log('PostgreSQL Plugin Logging: ' + this._ingredient.properties.parameters)
            await this._helper.DeployTemplate(this._name, this._armTemplate, params, await util.resource_group())
        } catch(error){
            this._logger.error('Deployment failed: ' + error)
            throw error
        }
    }

    private async getVnetData(params: { virtualNetworkResourceGroup: { value: string }; virtualNetworkName: { value: string }; subnetName: { value: string } }): Promise<VnetData> {
        const vNet: VirtualNetwork = await this._functions.get_vnet(params.virtualNetworkResourceGroup.value, params.virtualNetworkName.value)
        const subnet: Subnet = await this._functions.get_subnet(params.virtualNetworkResourceGroup.value, params.virtualNetworkName.value, params.subnetName.value)
        const privateDnsZoneName = this._functions.create_resource_uri(this._access!); 
        let dnsZone = await this._functions.get_private_dns_zone(params.virtualNetworkResourceGroup.value, privateDnsZoneName)
        let dnsZoneIsNew = false;

        // if dnsZone doesn't exist, generate its id
        if (dnsZone === undefined)
        {
            dnsZoneIsNew = true;
            dnsZone = { id: `/subscriptions/${this._ctx.Environment.authentication.subscriptionId}/resourceGroups/${params.virtualNetworkResourceGroup.value}` +
                `/providers/Microsoft.Network/privateDnsZones/${privateDnsZoneName}`};
        }

        // We need to assert non-null values for nullable VirtualNetwork and Subnet properties, though a 404 error in get_vnet() or get_subnet() will probably precede these checks
        if (!vNet.id || !vNet.location) {
            throw new Error(`Failed to find Virtual Network using ResourceGroup ${params.virtualNetworkResourceGroup.value} and name ${params.virtualNetworkName.value}`);
        }
        if (!subnet.addressPrefix || !subnet.id) {
            throw new Error(`Failed to find Subnet using ResourceGroup ${params.virtualNetworkResourceGroup.value}, Vnet name ${params.virtualNetworkName.value}, and Subnet name ${params.subnetName.value}`);
        }
        
        const vnetData: VnetData = {
            value: {
                virtualNetworkName: params.virtualNetworkName.value,
                virtualNetworkId: vNet.id,
                subnetName: params.subnetName.value,
                virtualNetworkAddressPrefix: subnet.addressPrefix,
                virtualNetworkResourceGroupName: params.virtualNetworkResourceGroup.value,
                location: vNet.location,
                subscriptionId: this._ctx.Environment.authentication.subscriptionId,
                subnetProperties: subnet,
                subnetNeedsUpdate: false,
                isNewVnet: false,
                usePrivateDnsZone: (this._access === "private"),
                isNewPrivateDnsZone: dnsZoneIsNew, 
                privateDnsResourceGroup: params.virtualNetworkResourceGroup.value,
                privateDnsSubscriptionId: this._ctx.Environment.authentication.subscriptionId,
                privateDnsZoneName: privateDnsZoneName,
                linkVirtualNetwork: true,
                Network: {
                    DelegatedSubnetResourceId: subnet.id,
                    PrivateDnsZoneArmResourceId: dnsZone.id 
                }
            }
        };
        return vnetData;
    }

    private validateBakeParams(params: any) {
        // This gets checked by the regular ARM validation anyway but might as well catch it early here.
        if (!params.serverName || !params.administratorLogin || !params.administratorLoginPassword) {
            throw new Error("serverName, administratorLogin, and administratorLoginPassword must be defined in the Bake parameters.");
        }

        // private access requires some special data for subnet
        if (this._access == "private") {
            if (!params.subnetName || !params.virtualNetworkName || !params.virtualNetworkResourceGroup) {
                throw new Error("subnetName, virtualNetworkName, and virtualNetworkResourceGroup must be defined in the Bake Parameters for 'private' access");
            } 
        }
    }

    // Remove parameters that are not defined in the ARM template. We call for extra params in the YAML so we can fetch necessary objects for ARM parameters like vNetData.
    private trimParametersForARM(params: any) {
        for (const param in params) {
            if (!Object.prototype.hasOwnProperty.call(this._armTemplate.parameters, param)) {
                delete params[param];
            }
        }
    }
}
