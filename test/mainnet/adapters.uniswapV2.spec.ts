/*
 * SPDX-License-Identifier: BSL-1.1
 * Gearbox. Generalized leverage protocol, which allows to take leverage and then use it across other DeFi protocols and platforms in a composable way.
 * (c) Gearbox.fi, 2021
 */

// @ts-ignore
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { expect } from "../../utils/expect";

import { Errors, UniswapV2Adapter__factory } from "../../types/ethers-v5";
import { TestDeployer } from "../../deployer/testDeployer";
import { MainnetSuite, UNISWAP_V2_ADDRESS } from "./helper";
import { MAX_INT, WAD } from "@diesellabs/gearbox-sdk";
import { BigNumber } from "ethers";
import { LEVERAGE_DECIMALS } from "../../core/constants";
import { tokenDataByNetwork, WETHToken } from "../../core/token";
import { UniV2helper } from "../../integrations/uniV2helper";

describe("UniswapV2 adapter", function () {
  this.timeout(0);

  const daiLiquidity = BigNumber.from(10000).mul(WAD);
  const ethLiquidity = BigNumber.from(50).mul(WAD);
  const accountAmount = BigNumber.from(1000).mul(WAD);
  const leverageFactor = 4 * LEVERAGE_DECIMALS;
  const referralCode = 888777;

  let ts: MainnetSuite;
  let deployer: SignerWithAddress;
  let user: SignerWithAddress;
  let liquidator: SignerWithAddress;
  let friend: SignerWithAddress;

  let errors: Errors;

  before(async () => {
    ts = await MainnetSuite.getSuite();
    const accounts = (await ethers.getSigners()) as Array<SignerWithAddress>;
    deployer = accounts[0];
    user = accounts[1];
    liquidator = accounts[2];
    friend = accounts[3];

    const testDeployer = new TestDeployer();
    errors = await testDeployer.getErrors();
    const r1 = await ts.daiToken.approve(ts.creditManagerDAI.address, MAX_INT);
    await r1.wait();
    const r2 = await ts.daiToken.approve(ts.poolDAI.address, MAX_INT);
    await r2.wait();
    const r3 = await ts.poolDAI.addLiquidity(daiLiquidity, deployer.address, 3);
    await r3.wait();
    const r4 = await ts.daiToken.approve(ts.leveragedActions.address, MAX_INT);
    await r4.wait();

    const poolAmount = await ts.poolETH.availableLiquidity();

    if (poolAmount.lt(ethLiquidity)) {
      const r5 = await ts.wethGateway.addLiquidityETH(
        ts.poolETH.address,
        deployer.address,
        2,
        { value: ethLiquidity.sub(poolAmount) }
      );
      await r5.wait();
    }
  });

  const openUserAccount = async () => {
    const amountOnAccount = accountAmount
      .mul(leverageFactor + LEVERAGE_DECIMALS)
      .div(LEVERAGE_DECIMALS);

    const adapter = await ts.creditFilterDAI.contractToAdapter(
      UNISWAP_V2_ADDRESS
    );

    const uniV2Helper = await UniV2helper.getHelper(
      UNISWAP_V2_ADDRESS,
      deployer
    );

    const r1 = await ts.creditManagerDAI.openCreditAccount(
      accountAmount,
      user.address,
      leverageFactor,
      referralCode
    );
    await r1.wait();

    const creditAccount = await ts.creditManagerDAI.getCreditAccountOrRevert(
      user.address
    );

    expect(
      (await ts.daiToken.balanceOf(creditAccount)).sub(amountOnAccount),
      "openUserAccount amountOnAccount"
    ).to.be.lte(1);

    const adapterContract = UniswapV2Adapter__factory.connect(adapter, user);

    return {
      amountOnAccount,
      creditAccount,
      uniV2Helper,
      adapter: adapterContract,
    };
  };

  const repayUserAccount = async (amountOnAccount: BigNumber) => {
    await ts.daiToken.transfer(user.address, amountOnAccount);
    await ts.daiToken
      .connect(user)
      .approve(ts.creditManagerDAI.address, MAX_INT);

    await ts.creditManagerDAI.connect(user).repayCreditAccount(friend.address);
  };

  it("[UV2-1]: swapExactTokenToTokens works correctly", async () => {
    const { amountOnAccount, creditAccount, uniV2Helper, adapter } =
      await openUserAccount();

    const path = [tokenDataByNetwork.Mainnet.DAI.address, WETHToken.Mainnet];

    const ethAmount = await uniV2Helper.getExpectedAmount(
      "ExactTokensToTokens",
      path,
      amountOnAccount
    );

    const r2 = await adapter.swapExactTokensForTokens(
      amountOnAccount,
      ethAmount,
      path,
      friend.address,
      UniV2helper.getDeadline()
    );
    await r2.wait();

    expect(await ts.daiToken.balanceOf(creditAccount)).to.be.lte(1);
    expect(await ts.wethToken.balanceOf(creditAccount)).to.be.gte(ethAmount);

    await repayUserAccount(amountOnAccount);
  });

  it("[UV2-2]: swapExactTokenToTokens works correctly", async () => {
    const { amountOnAccount, creditAccount, uniV2Helper, adapter } =
      await openUserAccount();

    const path = [tokenDataByNetwork.Mainnet.DAI.address, WETHToken.Mainnet];

    const ethAmount = await uniV2Helper.getExpectedAmount(
      "ExactTokensToTokens",
      path,
      amountOnAccount
    );

    const ethAmountExpected = ethAmount.mul(99).div(100);

    const amountToSwap = await uniV2Helper.getExpectedAmount(
      "TokensToExactTokens",
      path,
      ethAmountExpected
    );

    const r2 = await adapter.swapTokensForExactTokens(
      ethAmountExpected,
      amountToSwap,
      path,
      friend.address,
      UniV2helper.getDeadline()
    );
    await r2.wait();

    expect(
      amountOnAccount.sub(await ts.daiToken.balanceOf(creditAccount))
    ).to.be.lte(amountToSwap);
    expect(
      ethAmountExpected.sub(await ts.wethToken.balanceOf(creditAccount))
    ).to.be.lte(2);

    await repayUserAccount(amountOnAccount);
  });
});
