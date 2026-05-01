import { useState } from 'react'
import { type Hex, type TypedDataDefinition } from 'viem'
import { getPublicClient } from '../lib/clients'
import type { SmartAccountState } from '../lib/types'

interface SignTypedDataProps {
  accountState: SmartAccountState
  onBack: () => void
}

export function SignTypedData({ accountState, onBack }: SignTypedDataProps) {
  const userAddress = accountState.address || "0x0000000000000000000000000000000000000000"
  
  const [selectedExample, setSelectedExample] = useState<string>('simple')
  const [signature, setSignature] = useState<Hex | null>(null)
  const [verificationResult, setVerificationResult] = useState<boolean | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const examples: Record<string, TypedDataDefinition> = {
    simple: {
      domain: {
        name: 'MyDApp',
        version: '1',
        chainId: 11155111,
        verifyingContract: userAddress as `0x${string}`,
      },
      types: {
        Message: [
          { name: 'content', type: 'string' },
          { name: 'timestamp', type: 'uint256' }
        ]
      },
      primaryType: 'Message',
      message: {
        content: 'Hello World!',
        timestamp: BigInt(1703980800)
      }
    },
    mail: {
      domain: {
        name: 'Ether Mail',
        version: '1',
        chainId: 11155111,
        verifyingContract: userAddress as `0x${string}`,
      },
      types: {
        Person: [
          { name: 'name', type: 'string' },
          { name: 'wallet', type: 'address' }
        ],
        Mail: [
          { name: 'from', type: 'Person' },
          { name: 'to', type: 'Person' },
          { name: 'contents', type: 'string' }
        ]
      },
      primaryType: 'Mail',
      message: {
        from: {
          name: 'Alice',
          wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826'
        },
        to: {
          name: 'Bob',
          wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB'
        },
        contents: 'Hello, Bob!'
      }
    },
    permit: {
      domain: {
        name: 'Token Permit',
        version: '1',
        chainId: 11155111,
        verifyingContract: userAddress as `0x${string}`,
      },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' }
        ]
      },
      primaryType: 'Permit',
      message: {
        owner: userAddress,
        spender: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        value: BigInt('1000000000000000000'),
        nonce: BigInt(0),
        deadline: BigInt(1735689600)
      }
    }
  }

  const handleSign = async () => {
    if (!accountState.account) return

    const typedData = examples[selectedExample]

    try {
      setIsLoading(true)
      setError(null)
      setVerificationResult(null)
      
      const sig = await accountState.account.signTypedData(typedData)
      setSignature(sig)
      
      await handleVerify(sig, typedData)
    } catch (err) {
      console.error('Failed to sign typed data:', err)
      setError(err instanceof Error ? err.message : 'Failed to sign typed data')
    } finally {
      setIsLoading(false)
    }
  }

  const handleVerify = async (sig?: Hex, typedData?: TypedDataDefinition) => {
    const signatureToVerify = sig || signature
    const dataToVerify = typedData || examples[selectedExample]
    
    if (!signatureToVerify || !dataToVerify || !accountState.address) return

    try {
      setIsLoading(true)
      setError(null)
      
      const publicClient = getPublicClient()
      
      const isValid = await publicClient.verifyTypedData({
        address: accountState.address,
        domain: dataToVerify.domain,
        types: dataToVerify.types,
        primaryType: dataToVerify.primaryType,
        message: dataToVerify.message,
        signature: signatureToVerify,
      })
      
      setVerificationResult(isValid)
    } catch (err) {
      console.error('Failed to verify typed data signature:', err)
      setError(err instanceof Error ? err.message : 'Failed to verify typed data signature')
      setVerificationResult(false)
    } finally {
      setIsLoading(false)
    }
  }

  const handleClear = () => {
    setSignature(null)
    setVerificationResult(null)
    setError(null)
  }

  return (
    <div className="sign-typed-data">
      <h2>Sign & Verify Typed Data</h2>

      <div className="form-section">
        <div className="examples">
          <label>Select Example:</label>
          <div className="button-group">
            <button 
              onClick={() => setSelectedExample('simple')}
              className={selectedExample === 'simple' ? 'primary-button small' : 'secondary-button small'}
            >
              Simple Message
            </button>
            <button 
              onClick={() => setSelectedExample('mail')}
              className={selectedExample === 'mail' ? 'primary-button small' : 'secondary-button small'}
            >
              Mail Example
            </button>
            <button 
              onClick={() => setSelectedExample('permit')}
              className={selectedExample === 'permit' ? 'primary-button small' : 'secondary-button small'}
            >
              ERC-20 Permit
            </button>
          </div>
        </div>

        <div className="form-group">
          <label>Selected Typed Data:</label>
          <pre className="json-display">
            {JSON.stringify(examples[selectedExample], (_, value) =>
              typeof value === 'bigint' ? value.toString() : value
            , 2)}
          </pre>
        </div>

        <div className="button-group">
          <button 
            onClick={handleSign} 
            disabled={isLoading}
            className="primary-button"
          >
            {isLoading ? 'Signing...' : 'Sign Typed Data'}
          </button>
          <button 
            onClick={handleClear}
            className="secondary-button"
          >
            Clear Results
          </button>
        </div>
      </div>

      {error && (
        <div className="error-message">
          <strong>Error:</strong> {error}
        </div>
      )}

      {signature && (
        <div className="signature-section">
          <h3>Signature</h3>
          <div className="signature-display">
            <code>{signature}</code>
          </div>
          
          {verificationResult !== null && (
            <div className={`verification-result ${verificationResult ? 'valid' : 'invalid'}`}>
              <strong>Verification Result:</strong> {verificationResult ? '✓ Valid' : '✗ Invalid'}
            </div>
          )}
          
          {verificationResult === null && signature && (
            <button 
              onClick={() => handleVerify()} 
              disabled={isLoading}
              className="secondary-button"
            >
              Verify Signature
            </button>
          )}
        </div>
      )}

      <div className="actions">
        <button onClick={onBack} className="secondary-button">
          Back to Dashboard
        </button>
      </div>
    </div>
  )
}